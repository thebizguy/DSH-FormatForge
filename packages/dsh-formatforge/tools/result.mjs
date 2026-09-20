// tools/result.mjs
//
// ff_result — consume inbox artifacts without knowing file paths.
//   list mode : scan ~/.dsh/formatforge/inbox for .ff.json, return metadata rows.
//   fetch mode: given `id` (result_id prefix or file stem), return forged content
//               with smart pagination (E1 semantics).
// Security: reads confined to inbox; path traversal in `id` rejected.
//
// DSL contract (dsh-tools): parameters = flat value-schema; output = { schema, render }.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { join, basename } from 'node:path'
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { inboxDir } from '../services/inbox-watcher.mjs'
import { smartTruncate } from './_truncate.mjs'

const DEFAULT_MAX_CHARS = 12_000
/** 小产物整段解析的上限；更大的产物改用流式扫描（不把正文读进内存） */
const SMALL_ARTIFACT_BYTES = 64 * 1024
/** 大产物流式扫描的块大小（同一块 Buffer 复用，内存占用与产物大小无关） */
const SCAN_CHUNK_BYTES = 64 * 1024
/** meta 对象的收集上限——超过就当它不是协议 meta，绝不无界缓冲 */
const META_CAPTURE_BYTES = 64 * 1024
/** 键 token 的收集上限（协议键都是短名；超长字符串一律不当键看） */
const KEY_TOKEN_BYTES = 64
/** T2-5/audit：顶层 `"ok"` 字面量的收集上限。协议里它只可能是 `true`/`false`，
 *  8 字节绰绰有余；这是扫描器里最后一个没有上限的缓冲区，不设限就等于
 *  「内存边界与产物大小无关」这条自述的反例（`{"ok":` + 100MB 无终止字面量
 *  能在活着的 harness 进程里缓冲 100MB，实测 8MB 字面量 → 256MB 堆）。 */
const OK_LITERAL_BYTES = 8

/** v0.13.0: 截断逻辑已抽到 _truncate.mjs 共用；smartTruncate 由该模块导入（与 core/utils.py::smart_truncate 镜像） */

/**
 * 读产物的协议元数据（JS-H1b：顺带给出「是不是合法转换结果」的判定）。
 * 返回 {valid, meta, enhance}；不可读/不可解析返回 null。
 */
function readArtifactMeta(full, size) {
  if (size <= SMALL_ARTIFACT_BYTES) {
    let doc
    try {
      doc = JSON.parse(readFileSync(full, { encoding: 'utf8' }))
    } catch {
      return null
    }
    const data = doc?.data || {}
    const meta = data.meta || {}
    return { valid: doc?.ok === true && typeof data.content === 'string' && !!meta.result_id, meta, enhance: data.enhance || null }
  }
  // 大产物：流式扫描到 data.meta 为止，只把 meta 对象本身读进内存。
  // （旧实现读尾部 4KB 猜 meta —— 协议键序是 content → format → meta →
  //   structured_data → quality → enhance，meta 排第三：正文一大、meta 就离尾部很远，
  //   structured_data/quality 一超过 4KB 尾窗里就没有 result_id，真产物会被判成伪造。）
  const scanned = scanEnvelopeHead(full)
  if (!scanned) return null
  const meta = scanned.meta || {}
  return {
    valid: scanned.ok === true && scanned.contentIsString === true && !!meta.result_id,
    meta,
    enhance: null,
  }
}

/**
 * 顺序扫描产物直到 `data.meta` 闭合，返回 {ok, contentIsString, meta}；读不动返回 null。
 *
 * 为什么不是「找 "meta" 子串」：正文里可以出现任何字节，只有带引号/转义状态的
 * 结构化扫描才能区分「键」和「正文里的同名文本」。为什么不是整段 JSON.parse：
 * 产物可以到上百 MB，list 会对收件箱里每一份都做这件事。
 *
 * 内存边界：一块复用的 64KB 读缓冲 + ≤64B 的键 token + ≤64KB 的 meta 收集区。
 * 与产物大小无关；代价是顺序 I/O（meta 之前的正文必须读过去，但不驻留）。
 * 停止条件不预设键序：`ok`/`content`/`meta` 三项齐了就停，否则一路扫到 `data` 闭合。
 */
function scanEnvelopeHead(full) {
  let fd
  try {
    fd = openSync(full, 'r')
  } catch {
    return null
  }
  const buf = Buffer.alloc(SCAN_CHUNK_BYTES)
  let filePos = 0
  let depth = 0
  let inString = false
  let trailingBackslashes = 0 // 跨块的连续反斜杠数（判断块首引号是否被转义）
  const tokenBuf = Buffer.alloc(KEY_TOKEN_BYTES)
  let tokenLen = 0
  let tokenOverflow = false
  let lastToken = null // 最近一个完整的（短）字符串 token
  const keyAt = [] // keyAt[d] = 第 d 层当前正在赋值的键
  let okLiteral = null // 读到 `"ok":` 之后收集字面量
  let ok = false
  let contentIsString = false
  let capturing = false
  let captureBaseDepth = 0
  let captureStart = -1
  const captureParts = []
  let captureLen = 0
  let meta = null
  let metaSeen = false
  let done = false
  /** T2-5：`ok` 字面量越界 —— 信封不是协议产物（或已损坏），整份判为读不动 */
  let malformed = false

  const flushCapture = (endExclusive) => {
    if (!capturing || captureStart < 0) return true
    const part = Buffer.from(buf.subarray(captureStart, endExclusive))
    captureLen += part.length
    if (captureLen > META_CAPTURE_BYTES) {
      capturing = false // meta 不可能这么大 → 放弃，按「没读到 meta」处理
      captureStart = -1
      return false
    }
    captureParts.push(part)
    captureStart = -1
    return true
  }

  try {
    while (!done) {
      const read = readSync(fd, buf, 0, SCAN_CHUNK_BYTES, filePos)
      if (read <= 0) break
      filePos += read
      if (capturing) captureStart = 0
      let i = 0
      while (i < read) {
        if (inString) {
          // 跳到下一个未转义的引号；正文字符串在这里被整段跳过（不驻留）
          let q = buf.indexOf(0x22, i)
          while (q !== -1) {
            let bs = 0
            let k = q - 1
            while (k >= 0 && buf[k] === 0x5c) {
              bs++
              k--
            }
            if (k < 0) bs += trailingBackslashes
            if (bs % 2 === 0) break
            q = buf.indexOf(0x22, q + 1)
          }
          const end = q === -1 ? read : q
          if (!tokenOverflow) {
            const room = KEY_TOKEN_BYTES - tokenLen
            const take = Math.min(room, end - i)
            buf.copy(tokenBuf, tokenLen, i, i + take)
            tokenLen += take
            if (end - i > take) tokenOverflow = true
          }
          if (q === -1) {
            i = read
            break
          }
          lastToken = tokenOverflow ? null : tokenBuf.subarray(0, tokenLen).toString('utf8')
          inString = false
          i = q + 1
          continue
        }
        const c = buf[i]
        if (c === 0x22) {
          // 字符串开始；`data.content` 必须是字符串（与 fetchOne 的校验对齐）
          if (depth === 2 && keyAt[1] === 'data' && keyAt[2] === 'content') contentIsString = true
          inString = true
          tokenLen = 0
          tokenOverflow = false
          i++
          continue
        }
        if (c === 0x7b || c === 0x5b) {
          if (!capturing && c === 0x7b && depth === 2 && keyAt[1] === 'data' && keyAt[2] === 'meta') {
            capturing = true
            captureBaseDepth = depth
            captureStart = i
          }
          depth++
          keyAt[depth] = null
          i++
          continue
        }
        if (c === 0x7d || c === 0x5d) {
          if (okLiteral !== null) {
            ok = okLiteral === 'true'
            okLiteral = null
          }
          depth--
          if (capturing && depth === captureBaseDepth) {
            const okFlush = flushCapture(i + 1)
            capturing = false
            metaSeen = true
            if (okFlush) {
              try {
                const parsed = JSON.parse(Buffer.concat(captureParts).toString('utf8'))
                if (parsed && typeof parsed === 'object') meta = parsed
              } catch { /* meta 不可解析 → 当没读到 */ }
            }
          }
          i++
          // 协议键序下 content 在 meta 之前 → 这里就已经问完了，正常产物扫到 meta 即止。
          // 若 meta 反而排在前面（非协议顺序），继续扫到 data 闭合为止——不重蹈
          // 「假设键序」的覆辙，代价只是多读一遍（顺序 I/O，内存不变）。
          if (metaSeen && contentIsString) {
            done = true
            break
          }
          if (depth === 1 && keyAt[1] === 'data') {
            done = true
            break
          }
          continue
        }
        if (c === 0x3a) {
          keyAt[depth] = lastToken
          if (depth === 1 && lastToken === 'ok') okLiteral = ''
          lastToken = null
          i++
          continue
        }
        if (c === 0x2c) {
          if (okLiteral !== null) {
            ok = okLiteral === 'true'
            okLiteral = null
          }
          keyAt[depth] = null
          lastToken = null
          i++
          continue
        }
        if (okLiteral !== null && c > 0x20) {
          // T2-5：越界就地判非法，绝不继续累积。注意不能「只是停止累积」——
          // 那样 okLiteral 会停在一个被截断的值上，扫描器等于**猜**出了一个
          // ok（几乎必然是 false），与真·`ok:false` 信封无法区分。
          if (okLiteral.length >= OK_LITERAL_BYTES) {
            malformed = true
            done = true
            break
          }
          okLiteral += String.fromCharCode(c)
        }
        i++
      }
      if (!done) {
        if (!flushCapture(read)) { /* 超上限：capturing 已关掉 */ }
        // 块尾的连续反斜杠要带到下一块，否则块首引号的转义状态会判错
        let bs = 0
        while (bs < read && buf[read - 1 - bs] === 0x5c) bs++
        trailingBackslashes = bs === read ? trailingBackslashes + bs : bs
      }
    }
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch { /* ignore */ }
  }
  // T2-5：与小产物快路径一致 —— `JSON.parse` 失败同样返回 null（读不动 ≠ ok:false）
  if (malformed) return null
  return { ok, contentIsString, meta }
}

function listArtifacts() {
  const dir = inboxDir()
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.ff.json')) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      // round-1 H1 协议：成功信封 {ok, code, data:{content, format, meta:{parser, file_size, result_id, confidence}}}
      // 源文件名不入协议——由产物文件名承载（`foo.pdf.ff.json` → 源 `foo.pdf`）
      const info = readArtifactMeta(full, st.size)
      if (!info) continue
      const meta = info.meta || {}
      const stem = name.replace(/\.ff\.json$/, '')
      rows.push({
        id: meta.result_id || stem,
        file: name,
        source: stem,
        parser: meta.parser || '?',
        confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
        file_size: typeof meta.file_size === 'number' ? meta.file_size : null,
        enhance: info.enhance?.reason || null,
        valid: info.valid === true,
        forged_at: st.mtime.toISOString(),
        size_bytes: st.size,
        path: full,
      })
    } catch { /* concurrent delete etc. */ }
  }
  return rows.sort((a, b) => b.forged_at.localeCompare(a.forged_at))
}

export function createResultTool({ log = () => {} }) {
  return defineTool({
    name: 'ff_result',
    description: '查 FormatForge 收件箱产物。list=true 列出；id/ids 取回内容（可分页）。',
    parameters: {
      list: { type: 'boolean', default: false, description: '列出全部产物。' },
      id: { type: 'string', description: '单取回：result_id/文件名前缀。' },
      ids: { type: 'string', description: '批量：id 逗号分隔（≤20）。' },
      max_chars: { type: 'integer', default: DEFAULT_MAX_CHARS, description: '分页大小。' },
      offset: { type: 'integer', default: 0 },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'integer' },
          data: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
        },
      },
      render(_args, value) {
        if (value && value.ok === false && value.error) {
          return [{ type: 'text', text: `ff_result 失败 [${value.error.kind}]: ${value.error.message}` }]
        }
        const d = (value && value.data) || {}
        // R3.2: 批量结果渲染
        if (d.batch) {
          const parts = d.results.map((r) => {
            if (!r.ok) return `- ❌ ${r.error?.message || '失败'}`
            const rd = r.data
            const enh = rd.enhance?.needed ? ` ⚠enhance=${rd.enhance.reason}` : ''
            const trunc = rd.truncated ? `（已截断，续读 offset=${rd.next_offset}）` : ''
            return `- [${rd.id}] ${rd.source} (parser=${rd.parser}, confidence=${rd.confidence ?? '?'}${enh})${trunc}\n${rd.content}`
          })
          return [
            {
              type: 'text',
              text: `FormatForge 批量取回 ${d.ok_count}/${d.count} 份：\n\n${parts.join('\n\n---\n\n')}`,
            },
          ]
        }
        if (d.count !== undefined) {
          if (d.count === 0) return [{ type: 'text', text: 'FormatForge 收件箱当前为空。把文件拖进网页即可自动锻造。' }]
          const lines = d.items.map(
            (it) =>
              `- [${it.id}] ${it.source} (parser=${it.parser}, confidence=${it.confidence ?? '?'}` +
              `${it.enhance ? `, ⚠enhance=${it.enhance}` : ''}, ${Math.round(it.size_bytes / 1024)}KB, ${it.forged_at})` +
              `${it.valid === false ? ' ⚠非转换产物（伪造/损坏，取回会被拒）' : ''}`,
          )
          return [{ type: 'text', text: `FormatForge 收件箱共 ${d.count} 个产物：\n${lines.join('\n')}\n\n用 ff_result(id=...) 取回内容。` }]
        }
        const enh = d.enhance?.needed ? `\n[enhance:${d.enhance.reason}] ${d.enhance.hint}` : ''
        const pageNote = d.truncated ? `\n\n[已截断；继续读取请带 offset=${d.next_offset}]` : ''
        return [
          {
            type: 'text',
            text:
              `FormatForge 产物 ${d.id} (${d.source}, parser=${d.parser}, confidence=${d.confidence ?? '?'})\n` +
              `可读版：${d.md_path}\n\n${d.content}${enh}${pageNote}`,
          },
        ]
      },
    },
    async execute(args) {
      const wantList = args.list || (!args.id && !args.ids)
      if (wantList) {
        const items = listArtifacts()
        log(`[ff_result] listed ${items.length} artifact(s)`)
        return { ok: true, code: 200, data: { count: items.length, items } }
      }

      // R3.2: 批量模式 —— ids 逗号分隔，逐份复用单取回逻辑
      if (args.ids && String(args.ids).trim()) {
        const ids = String(args.ids)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20)
        if (ids.length === 0) {
          return { ok: false, code: 4003, error: { kind: 'bad_request', message: 'ids 为空' } }
        }
        const results = []
        for (const oneId of ids) {
          results.push(await fetchOne(oneId, args, log))
        }
        const okCount = results.filter((r) => r.ok).length
        log(`[ff_result] batch fetched ${okCount}/${ids.length}`)
        return { ok: true, code: 200, data: { batch: true, count: ids.length, ok_count: okCount, results } }
      }

      return await fetchOne(String(args.id), args, log)
    },
  })
}

/** 单份取回（id 解析 + 路径安全 + 分页），单/批量共用。 */
async function fetchOne(rawId, args, log) {
  // 路径安全：id 不允许分隔符与 ..
  if (/[/\\]|\.\./.test(rawId)) {
    return { ok: false, code: 4003, error: { kind: 'bad_request', message: '非法 id：不允许路径分隔符或 ..' } }
  }
  const dir = inboxDir()
  let target = null
  try {
    const names = readdirSync(dir).filter((n) => n.endsWith('.ff.json'))
    // v0.13.0/C6: 删 includes() 兜底（id="abc" 会命中 xxxabcxxx.ff.json 是误匹配）
    // 四段递进：旧式精确 stem（foo.ff.json）→ 新式精确 stem（foo.pdf.ff.json，含源扩展名）
    //          → 源 stem 前缀（foo → foo.pdf）→ JSON 头里的 result_id（精确，再 8 位以上前缀）
    const stemOf = (n) => n.replace(/\.ff\.json$/, '')
    target =
      names.find((n) => n === `${rawId}.ff.json`) ||
      names.find((n) => stemOf(n) === rawId) ||
      names.find((n) => stemOf(n).startsWith(`${rawId}.`)) ||
      null
    if (!target && names.length > 0) {
      let idPrefixHit = null
      for (const n of names) {
        try {
          const np = join(dir, n)
          const info = readArtifactMeta(np, statSync(np).size)
          const rid = info?.meta?.result_id
          if (!rid) continue
          // 精确匹配协议里的 result_id（唯一写入方 inbox-watcher 存的是 CLI 信封逐字拷贝）
          if (rid === rawId) {
            target = n
            break
          }
          if (!idPrefixHit && rawId.length >= 8 && rid.startsWith(rawId)) idPrefixHit = n
        } catch { /* skip */ }
      }
      if (!target && idPrefixHit) target = idPrefixHit
    }
  } catch {
    target = null
  }
  if (!target) {
    return {
      ok: false,
      code: 4002,
      error: { kind: 'file_not_found', message: `收件箱中找不到匹配 "${rawId}" 的产物（可先 list=true 查看）。` },
    }
  }

  const full = join(dir, target)
  let doc
  try {
    doc = JSON.parse(readFileSync(full, { encoding: 'utf8' }))
  } catch (e) {
    return { ok: false, code: 4004, error: { kind: 'parse_failed', message: `产物损坏无法解析: ${e.message}` } }
  }
  const data = doc.data || {}
  const meta = data.meta || {}
  // JS-H1b 信任边界：`.json` 是上传白名单扩展名 → 任何人（或页面）都能伪造
  // `anything.ff.json` 丢进收件箱。只认 round-1 成功信封（ok:true + string content
  // + meta.result_id）；其余一律拒绝，绝不把原始文件字节当「转换结果」端给模型。
  if (doc.ok !== true || typeof data.content !== 'string' || !meta.result_id) {
    return {
      ok: false,
      code: 4005,
      error: {
        kind: 'not_a_conversion_result',
        message: `产物 ${basename(target)} 不是合法的转换结果（需 ok:true + content + meta.result_id）——已拒绝返回。`,
      },
    }
  }
  const content = data.content
  // 参数归一：0/负数/非数回落到默认（`max_chars: 0` 在调用方=未指定），非整数向下取整
  const rawMax = Number(args.max_chars)
  const maxChars = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_MAX_CHARS
  const start = Math.max(0, Math.floor(Number(args.offset) || 0))
  const { chunk, nextOffset } = smartTruncate(content, maxChars, start)

  log(`[ff_result] fetched ${target} (${chunk.length} chars @${start})`)
  return {
    ok: true,
    code: 200,
    data: {
      id: meta.result_id || target.replace(/\.ff\.json$/, ''),
      file: basename(target),
      source: target.replace(/\.ff\.json$/, ''),
      parser: meta.parser || '?',
      confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      file_size: meta.file_size ?? null,
      enhance: data.enhance || null,
      md_path: full.replace(/\.ff\.json$/, '.ff.md'),
      content: chunk,
      truncated: nextOffset !== undefined,
      next_offset: nextOffset,
    },
  }
}
