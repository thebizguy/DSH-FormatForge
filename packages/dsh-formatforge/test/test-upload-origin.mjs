// packages/dsh-formatforge/test/test-upload-origin.mjs
//
// v1.0.3/JS-H6 回归：上传路由只服务本机（环回），但此前**没有 Origin 检查** ——
// DNS rebinding 会让攻击者域名发出的 POST 被浏览器当作同源请求打进来；
// 经典 CSRF 只是碰巧被一个规范非法的 ACAO 值挡住。本测试断言：
//   - 缺 Origin（curl/后端）放行；环回 Origin（任意端口）放行；
//   - 任意外部 Origin / Origin: null → 403 且不落盘；
//   - preflight 回显校验通过的 Origin（旧值 'same-origin' 是规范非法值）；
//   - 产物形状的文件名（`x.ff.json`）在上传口被拒（M11：伪造产物绕过转换）；
//   - NUL/控制字符文件名不再让 basename() 抛异常；
//   - 同名上传原子创建 + 追加序号（关掉 existsSync→writeFileSync 的 TOCTOU）。
//
// 用法：node packages/dsh-formatforge/test/test-upload-origin.mjs

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`✅ ${name}`)
  } else {
    failures++
    console.error(`❌ ${name}  ${detail}`)
  }
}

const home = mkdtempSync(join(tmpdir(), 'ff-upload-test-'))
const inbox = join(home, 'inbox')
mkdirSync(inbox, { recursive: true })
process.env.FF_HOME = home
process.on('exit', () => rmSync(home, { recursive: true, force: true }))

const { registerUploadRoute } = await import('../http/upload.mjs')

// ---- 假 webServer：抓住 handler 手动驱动 ----
let handler = null
const ctx = { get: () => ({ register: (spec) => { if (spec.path === '/formatforge/upload') handler = spec.handler } }) }
const logs = []
check('route registered', registerUploadRoute(ctx, { maxBytes: 1024 * 1024, log: (l) => logs.push(l) }) === true && !!handler)

function makeReq({ method = 'POST', origin, filename, body = 'hello' }) {
  const req = new EventEmitter()
  req.method = method
  req.headers = {}
  if (origin !== undefined) req.headers.origin = origin
  if (filename !== undefined) req.headers['x-ff-filename'] = encodeURIComponent(filename)
  req.destroy = () => {}
  // 异步投递 body，模拟真实请求流
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers || {}
  }
  res.end = (b) => {
    res.body = b || ''
  }
  return res
}

async function post(opts) {
  const req = makeReq(opts)
  const res = makeRes()
  await handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, json, raw: res.body }
}

console.log('\n=== upload route Origin allowlist (JS-H6) ===\n')

// 1) 缺 Origin（非浏览器客户端）→ 放行
const noOrigin = await post({ filename: 'no-origin.pdf' })
check('absent Origin allowed (curl/backend)', noOrigin.status === 200 && noOrigin.json?.saved === 'no-origin.pdf', JSON.stringify(noOrigin))

// 2) 环回 Origin → 放行
const loopback = await post({ origin: 'http://127.0.0.1:3080', filename: 'loopback.pdf' })
check('loopback Origin allowed (127.0.0.1:3080)', loopback.status === 200, JSON.stringify(loopback))
const localhost = await post({ origin: 'http://localhost:5173', filename: 'localhost.pdf' })
check('loopback Origin allowed (localhost:5173)', localhost.status === 200, JSON.stringify(localhost))
const httpsLoopback = await post({ origin: 'https://[::1]:8443', filename: 'v6.pdf' })
check('loopback IPv6 Origin allowed', httpsLoopback.status === 200, JSON.stringify(httpsLoopback))

// 3) 外部 Origin / Origin:null → 403，绝不落盘
const before = readdirSync(inbox).length
const evil = await post({ origin: 'http://evil.example', filename: 'evil.pdf' })
check('external Origin rejected 403', evil.status === 403 && evil.json?.error === 'forbidden_origin', JSON.stringify(evil))
const rebind = await post({ origin: 'http://attacker.example:3080', filename: 'rebind.pdf' })
check('DNS-rebinding style Origin rejected', rebind.status === 403, JSON.stringify(rebind))
const nullOrigin = await post({ origin: 'null', filename: 'null.pdf' })
check('Origin: null rejected', nullOrigin.status === 403, JSON.stringify(nullOrigin))
const lookalike = await post({ origin: 'http://127.0.0.1.evil.example', filename: 'look.pdf' })
check('lookalike host rejected', lookalike.status === 403, JSON.stringify(lookalike))
check('rejected uploads wrote nothing', readdirSync(inbox).length === before, JSON.stringify(readdirSync(inbox)))

// 4) preflight 回显合法 Origin（不再是规范非法的 'same-origin'）
const pre = await post({ method: 'OPTIONS', origin: 'http://127.0.0.1:3080' })
check('preflight echoes validated Origin', pre.status === 204 && pre.headers['access-control-allow-origin'] === 'http://127.0.0.1:3080', JSON.stringify(pre))
const preEvil = await post({ method: 'OPTIONS', origin: 'http://evil.example' })
check('preflight from bad Origin rejected', preEvil.status === 403, JSON.stringify(preEvil))

// 5) M11：产物形状的文件名在上传口被拒
const forged = await post({ filename: 'anything.ff.json', body: '{"ok":true}' })
check('artifact-shaped upload rejected (M11)', forged.status === 415 && String(forged.json?.error).startsWith('artifact_name_rejected'), JSON.stringify(forged))
const forgedMd = await post({ filename: 'x.FF.MD', body: 'forged' })
check('artifact-shaped upload rejected (case-insensitive)', forgedMd.status === 415, JSON.stringify(forgedMd))

// 6) NUL / 控制字符文件名不再炸
const nulName = await post({ filename: 'bad\u0000name\n.pdf' })
check('NUL/CRLF filename sanitized, no throw', nulName.status === 200 && !/[\u0000\n\r]/.test(nulName.json?.saved || ''), JSON.stringify(nulName))
const badEscape = await post({ filename: 'ok.pdf' })
check('normal upload still works', badEscape.status === 200 && badEscape.json?.size === 5, JSON.stringify(badEscape))

// 7) 同名冲突：原子创建 + 序号
writeFileSync(join(inbox, 'dup.pdf'), 'preexisting')
const dup = await post({ filename: 'dup.pdf', body: 'new bytes' })
check('same-name upload gets a numbered name (no clobber)', dup.status === 200 && dup.json?.saved === 'dup(1).pdf', JSON.stringify(dup))
check('preexisting file untouched', readdirSync(inbox).includes('dup.pdf'), JSON.stringify(readdirSync(inbox)))

// 8) 扩展名白名单（M11 的另一面：白名单本身）
const exe = await post({ filename: 'payload.exe' })
check('non-whitelisted extension rejected', exe.status === 415, JSON.stringify(exe))
const jsonDoc = await post({ filename: 'real-doc.json', body: '{"a":1}' })
check('.json is still accepted as a SOURCE document', jsonDoc.status === 200, JSON.stringify(jsonDoc))

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ upload Origin allowlist + upload boundary hold')