/**
 * 交付包独立验收 —— `npm run verify:delivery`
 *
 * 与 `pack:delivery` 末尾的自检不同，这个脚本**从外部**验收已经生成的交付包，模拟甲方实际会做的四件事：
 *
 *   1. 核对 `SHA256SUMS.txt`：每一个文件的哈希是否真的对得上（交付物完整性）；
 *   2. 真起一次 `server.cjs`，用 HTTP 把 `app/` 整包拉一遍（PWA 那条路径真的能用吗）；
 *   3. 检查 `CohortLens.html` 是不是真的自包含（"单文件"这个说法能不能兑现）；
 *   4. 扫一遍凭据形状（交付物里不能有任何密钥）。
 *
 * 为什么值得单独写一个脚本：`pack:delivery` 的自检用的是同一份代码路径，而"用它自己的检查证明它自己
 * 没问题"不是独立证据。这里重新实现一遍检查，包括读文件、起服务、发请求，都是独立的。
 */

import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(root, 'delivery', 'CohortLens-交付包')

let failures = 0
let checks = 0

function check(ok: boolean, label: string, detail?: string): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`)
}

function heading(text: string): void {
  console.log(`\n=== ${text} ===`)
}

if (!existsSync(bundle)) {
  console.error(`交付包不存在：${bundle}\n请先运行 npm run pack:delivery`)
  process.exit(1)
}

// --- 1. integrity -----------------------------------------------------------
heading('1. SHA256SUMS.txt 逐文件核对')
const sums = readFileSync(join(bundle, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')
let verified = 0
for (const line of sums) {
  const separator = line.indexOf('  ')
  if (separator < 0) continue
  const expected = line.slice(0, separator)
  const rel = line.slice(separator + 2)
  const full = join(bundle, rel.split('/').join(sep))
  if (!existsSync(full)) {
    check(false, `清单里的文件不存在：${rel}`)
    continue
  }
  const actual = createHash('sha256').update(readFileSync(full)).digest('hex').toUpperCase()
  if (actual !== expected) check(false, `哈希不符：${rel}`, `${expected} != ${actual}`)
  else verified += 1
}
check(verified === sums.length, `${verified}/${sums.length} 项哈希一致`)

// --- 2. the PWA bundle actually serves --------------------------------------
heading('2. server.cjs 真起服务，逐条拉取 app/ 整包')
const port = 4711
let server: ChildProcess | null = null

interface Response {
  status: number
  type: string
  body: Buffer
}

function get(path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
        }),
      )
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('请求超时')))
  })
}

async function waitReady(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await get('/')
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return false
}

try {
  server = spawn(process.execPath, [join(bundle, 'server.cjs'), String(port), '--no-open'], {
    cwd: bundle,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const ready = await waitReady()
  check(ready, 'server.cjs 能启动并响应')
  if (ready) {
    const shell = await get('/')
    check(
      shell.status === 200 && shell.body.toString('utf8').includes('CohortLens'),
      'index.html 可访问',
      `status=${shell.status}`,
    )
    check(shell.type.includes('text/html'), 'index.html 类型正确', shell.type)

    const manifest = await get('/manifest.webmanifest')
    check(manifest.status === 200, 'manifest.webmanifest 可访问', `status=${manifest.status}`)

    const serviceWorker = await get('/sw.js')
    check(
      serviceWorker.status === 200 && serviceWorker.body.toString('utf8').includes('workbox'),
      'sw.js 可访问且包含 workbox',
      `status=${serviceWorker.status}`,
    )

    const icon = await get('/icons/pwa-192x192.png')
    check(icon.status === 200 && icon.body.length > 500, 'PWA 图标可访问', `${icon.body.length} B`)

    const traversal = await get('/../../../../Windows/win.ini')
    check(
      traversal.status === 403 || !traversal.body.toString('utf8').includes('[fonts]'),
      '路径越界被拒绝',
      `status=${traversal.status}`,
    )

    const nested = await get('/some/deep/route')
    check(
      nested.status === 200 && nested.body.toString('utf8').includes('CohortLens'),
      '未知路径回落外壳（hash 路由友好）',
    )
  }
} finally {
  server?.kill()
}

// --- 3. single file is genuinely single -------------------------------------
heading('3. CohortLens.html 自包含性')
const singleHtml = readFileSync(join(bundle, 'CohortLens.html'), 'utf8')
const refs = [...singleHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1] ?? '')
  .filter((url) => !url.startsWith('data:'))
check(refs.length === 0, '无任何外部 src/href 引用', refs.join(', '))
check(!singleHtml.includes('serviceWorker'), '不含 serviceWorker 引用')
check(!singleHtml.includes('workbox'), '不含 workbox 引用')
check(singleHtml.includes('A0_declared_identity'), '已内联 A 层 V1.1 内容')
check(!singleHtml.includes('question-pack-v1.0'), '未内联已退役的 V1.0 题库')
check(singleHtml.length > 400_000, '内容量符合预期', `${(singleHtml.length / 1024).toFixed(0)} KiB`)

// --- 4. credentials ---------------------------------------------------------
heading('4. 凭据形状扫描（剔除应用自身的反泄漏工具串）')
/**
 * The app ships the patterns it uses to *detect* a key (`/sk-.../`), the
 * `Authorization: Bearer ${key}` header template, and the IndexedDB record key `apiKey`. Those are
 * the anti-leak machinery, so they are removed before scanning; what remains must contain nothing
 * shaped like a real credential.
 */
const allowed = [
  '/sk-[A-Za-z0-9_-]{16,}/g',
  '/sk-proj-[A-Za-z0-9_-]{16,}/g',
  'Authorization:`Bearer ${o}`',
  '`Bearer ${',
]
const shapes: { name: string; re: RegExp }[] = [
  { name: 'OpenAI 风格密钥', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API Key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'Anthropic 密钥', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Bearer 令牌字面量', re: /Bearer\s+[A-Za-z0-9._-]{25,}/g },
  {
    name: '配置字段里的长随机串',
    re: /"(?:apiKey|api_key|token|secret)"\s*:\s*"[A-Za-z0-9_\-.]{24,}"/g,
  },
]

const allFiles: string[] = []
const collect = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collect(full)
    else allFiles.push(full)
  }
}
collect(bundle)

let scanned = 0
for (const file of allFiles) {
  if (/\.(png|jpg|ico|woff2)$/i.test(file)) continue
  let text = readFileSync(file, 'utf8')
  scanned += 1
  for (const snippet of allowed) text = text.split(snippet).join('<ALLOWED>')
  for (const shape of shapes) {
    const hits = [...text.matchAll(shape.re)].map((match) => match[0])
    if (hits.length > 0) {
      check(false, `${relative(bundle, file)} 疑似真实凭据（${shape.name}）`, hits[0])
    }
  }
}
check(true, `扫描 ${scanned} 个文本文件，未发现真实凭据形状`)

console.log(
  `\n${failures === 0 ? `全部 ${checks} 项检查通过` : `${checks} 项检查中有 ${failures} 项失败`}`,
)
process.exit(failures === 0 ? 0 : 1)
