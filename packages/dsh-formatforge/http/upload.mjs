// http/upload.mjs
//
// POST /formatforge/upload — browser drop target for non-image files.
//
// Contract:
//   Request  : raw body = file bytes. Headers carry metadata (avoids multipart
//              parsing entirely; fetch() in the client module sends them natively):
//                x-ff-filename : UTF-8 filename (RFC 5987 style, raw utf-8 ok on loopback)
//                content-type  : browser-reported MIME (advisory only)
//   Response : { ok: true, saved: <path>, size: N }
//              { ok: false, error: '<reason>' } with 4xx
//
// Safety: loopback server already gates external access; we still enforce
//          Origin allowlist (JS-H6, DNS-rebinding) + extension whitelist +
//          size cap + filename sanitization (basename only) + atomic create.

import { join, basename, extname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInboxWatcher, inboxDir, isArtifactName } from '../services/inbox-watcher.mjs'

/** JS-H6: 只认本机来源——dsh web UI（127.0.0.1/localhost/[::1]，任意端口）。
 *  缺 Origin 的请求（curl / 后端调用）放行：非浏览器客户端本来就无法被网页 drive-by。 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

function originAllowed(req) {
  const origin = req.headers?.origin
  if (origin === undefined || origin === '') return true
  return typeof origin === 'string' && LOOPBACK_ORIGIN_RE.test(origin)
}

/** 日志/文件名里的控制字符（含 NUL/CR/LF）：NUL 会让 basename() 直接抛异常。 */
function stripControl(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '_')
}

const KNOWN_EXT = new Set([
  // H18/audit: .doc/.ppt/.xlsb 移除（无解析器，收缩宣称）——未知扩展交 CLI 报 unsupported_format
  '.pdf', '.docx', '.pptx', '.xlsx', '.xlsm', '.csv', '.txt', '.md', '.markdown',
  '.rtf', '.odt', '.ods', '.odp', '.html', '.htm', '.xml', '.json', '.yaml', '.yml',
  '.toml', '.eml', '.msg', '.epub', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.bmp', '.tiff', '.zip', '.7z', '.rar', '.srt', '.sql', '.latex', '.tex',
])

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > maxBytes) {
        reject(new Error('too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function registerUploadRoute(ctx, { maxBytes, log }) {
  const webServer = ctx.get && ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    log('[ff-upload] webServer unavailable; /formatforge/upload NOT registered')
    return false
  }

  webServer.register({
    kind: 'exact',
    path: '/formatforge/upload',
    handler: async (req, res) => {
      // JS-H6: Origin 白名单（DNS rebinding 会把攻击者域名的请求变成「同源」POST）
      if (!originAllowed(req)) {
        log(`[ff-upload] rejected Origin: ${stripControl(req.headers?.origin).slice(0, 120)}`)
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden_origin' }))
        return
      }
      // CORS preflight（同源部署其实用不到，防御性保留；回显校验通过的 Origin
      // ——旧值 'same-origin' 是规范非法值，任何浏览器都不会接受）
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': req.headers?.origin || 'null',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-ff-filename',
          vary: 'origin',
        })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
        return
      }

      let rawName
      try {
        rawName = decodeURIComponent(req.headers['x-ff-filename'] || '')
      } catch {
        rawName = req.headers['x-ff-filename'] || ''
      }
      // 控制字符（含 %00/NUL/CRLF）先替换：basename() 遇到 NUL 会抛 ERR_INVALID_ARG_VALUE，
      // 而 CR/LF 还能一路进收件箱文件名与通知文本
      const safeName = basename(stripControl(rawName).replace(/[\\/:*?"<>|]/g, '_'))
      const ext = extname(safeName).toLowerCase()

      if (!safeName || !ext || !KNOWN_EXT.has(ext)) {
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `unsupported_format: ${safeName || '(no name)'}` }))
        return
      }
      // JS-H6/M11: 产物形状的名字（`x.ff.json` 等）不是源文档 —— 上传口拒收，
      // 否则伪造的 `.ff.json` 会绕过转换直接躺在收件箱里被当作「转换结果」
      if (isArtifactName(safeName)) {
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `artifact_name_rejected: ${safeName}` }))
        return
      }

      const dir = inboxDir()
      try {
        mkdirSync(dir, { recursive: true })
      } catch { /* exists */ }

      let body
      try {
        body = await readRawBody(req, maxBytes)
      } catch (e) {
        res.writeHead(e.message === 'too_large' ? 413 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
        return
      }
      if (body.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'empty_body' }))
        return
      }

      // 同名冲突 + TOCTOU：用 O_EXCL(flag:'wx') 原子创建，EEXIST 时追加序号重试
      //（旧的 existsSync→writeFileSync 之间两个并发同名上传会互相覆盖）
      const stem = safeName.slice(0, safeName.length - ext.length)
      let finalName = safeName
      let dest = ''
      for (let attempt = 0; ; attempt++) {
        dest = join(dir, finalName)
        try {
          writeFileSync(dest, body, { flag: 'wx' })
          break
        } catch (e) {
          if (e.code !== 'EEXIST' || attempt >= 100) {
            log(`[ff-upload] write failed: ${e.message}`)
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: `write_failed: ${e.message}` }))
            return
          }
          finalName = `${stem}(${attempt + 1})${ext}`
        }
      }

      log(`[ff-upload] ${finalName} (${body.length}B) -> inbox`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, saved: finalName, size: body.length }))
    },
  })

  // 健康检查
  webServer.register({
    kind: 'exact',
    path: '/formatforge/health',
    handler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, plugin: 'dsh-formatforge', inbox: inboxDir() }))
    },
  })

  log('[ff-upload] routes registered: POST /formatforge/upload, GET /formatforge/health')
  return true
}
