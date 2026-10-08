/**
 * 零依赖本地静态服务器 —— 甲方交付包专用。
 *
 * 为什么需要它：单文件版 `CohortLens.html` 双击就能用，但浏览器的 Service Worker（也就是"装成
 * 应用、断网也能打开"的那部分）**只在 http(s) 下才允许注册**，`file://` 一定不行。所以交付包里
 * 放两种用法：
 *
 *   - 双击 `CohortLens.html`   —— 最快，单文件自带全部内容，不需要这个脚本；
 *   - 双击 `启动本地服务器.cmd` —— 由本脚本起一个 http 服务，于是可以"安装成应用"并真正离线可用。
 *
 * 这个脚本**只用 Node 内置模块**，没有任何 npm 依赖，所以甲方机器上不需要 `npm install`。
 * 它只读取 `app/` 目录下的文件，不写入任何东西、不联网、不收集数据。
 *
 * 用法：
 *   node server.cjs               # 默认 4173 端口，自动打开浏览器
 *   node server.cjs 8080          # 指定端口
 *   node server.cjs 8080 --no-open
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const ROOT = path.join(__dirname, 'app')
const args = process.argv.slice(2)
const port = Number(args.find((value) => /^\d+$/.test(value)) ?? 4173)
const shouldOpen = !args.includes('--no-open')

/** Minimal extension -> content type map. Anything unknown is served as octet-stream. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

if (!fs.existsSync(ROOT)) {
  console.error(`[CohortLens] 找不到 ${ROOT}。请确认 app/ 目录与 server.cjs 在同一个文件夹里。`)
  process.exit(1)
}

/**
 * Resolve a request path to a file inside ROOT.
 *
 * Everything is resolved through `path.resolve` and then checked to still start with ROOT, so a
 * request like `/../../C:/Windows/win.ini` cannot escape the delivery folder. This is a local
 * convenience server for one person on one machine, but a path-traversal hole is not something to
 * leave in a file that ships to a client.
 */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const candidate = path.resolve(ROOT, `.${decoded}`)
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null
  return candidate
}

const server = http.createServer((request, response) => {
  const requested = resolveFile(request.url ?? '/')
  if (!requested) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('403 路径越界')
    return
  }

  let filePath = requested
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html')
  }
  // A hash router only ever asks for the shell, but a stale bookmark can ask for a nested path.
  if (!fs.existsSync(filePath)) filePath = path.join(ROOT, 'index.html')

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('404 找不到文件')
      return
    }
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    response.writeHead(200, {
      'content-type': type,
      // The service worker must never be cached, or an update would never be picked up.
      'cache-control': filePath.endsWith('sw.js') ? 'no-cache' : 'no-cache',
    })
    response.end(data)
  })
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[CohortLens] 端口 ${port} 已被占用。请换一个端口，例如：node server.cjs ${port + 1}`,
    )
  } else {
    console.error('[CohortLens] 服务器启动失败：', error.message)
  }
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.log('')
  console.log('  CohortLens 本地服务器已启动')
  console.log(`  地址：${url}`)
  console.log('')
  console.log('  · 在浏览器里打开上面的地址即可使用。')
  console.log('  · 想"安装成应用"：Chrome/Edge 地址栏右侧会出现安装图标，点它即可。')
  console.log('  · 关闭这个黑色窗口就等于关闭服务器；数据已经存在浏览器里，不会丢。')
  console.log('')

  if (shouldOpen) {
    const opener =
      process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    execFile(opener, openerArgs, () => {
      // Opening the browser is a convenience; failing to do so must not stop the server.
    })
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  CohortLens 本地服务器已停止。')
    server.close(() => process.exit(0))
  })
}
