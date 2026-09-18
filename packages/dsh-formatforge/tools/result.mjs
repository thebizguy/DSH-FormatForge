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
/** 小产物整段解析的上限；更大的产物只读首尾（协议里 meta 排在 content 之后） */
const SMALL_ARTIFACT_BYTES = 64 * 1024

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
  // 大产物：不把整份正文读进内存——首 64B 判 ok，尾 4KB 取 meta 字段
  let head = ''
  let tail = ''
  try {
    const fd = openSync(full, 'r')
    try {
      const hb = Buffer.alloc(64)
      head = hb.subarray(0, readSync(fd, hb, 0, 64, 0)).toString('utf8')
      const tb = Buffer.alloc(4096)
      tail = tb.subarray(0, readSync(fd, tb, 0, 4096, Math.max(0, size - 4096))).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const str = (key) => {
    const m = tail.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))
    return m ? m[1] : null
  }
  const num = (key) => {
    const m = tail.match(new RegExp(`"${key}"\\s*:\\s*(-?[0-9.]+)`))
    return m ? Number(m[1]) : null
  }
  const resultId = str('result_id')
  return {
    valid: /"ok"\s*:\s*true/.test(head) && !!resultId,
    // 协议里 meta 在 content 之后、quality/enhance 之前 → 尾部的首个匹配即 meta 字段
    meta: { result_id: resultId, parser: str('parser'), confidence: num('confidence'), file_size: num('file_size') },
    enhance: null,
  }
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
