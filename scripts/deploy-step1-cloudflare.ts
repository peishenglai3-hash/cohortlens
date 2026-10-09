/**
 * 部署第 1 步 —— 一条命令做完 Cloudflare 登录后需要的三件事。
 *
 * 为什么是 .ts 而不是 .ps1：这一段的唯一难点是**可靠地解析 wrangler 的输出**（账号行、
 * database_id）并把它写进 wrangler.toml。这类"取字段 + 改文件"的活在一个有类型、能单测的环境里
 * 做要稳得多；PowerShell 那边的引号/转义规则本身就是一个 bug 来源（我在这上面栽了三次）。
 * 于是：PowerShell 只负责一件事 —— 调用 `npx wrangler`，剩下的都交给这里。
 *
 * 用法（PowerShell，在仓库根目录）：
 *   npm run deploy:step1
 *
 * 它做三件事，每件都先检查再执行：
 *   1. 确认已登录（没登录就调用 `wrangler login`，浏览器会弹授权页）
 *   2. 创建 D1 数据库 cohortlens-reviews（已存在则查出它的 id 复用）
 *   3. 把 database_id 写进 wrangler.toml 的 [[d1_databases]] 段
 *
 * 它**不会**设置任何口令、不会部署、不会上传数据。口令那一步由人亲自执行。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyDatabaseId,
  DB_NAME,
  parseCreatedDatabaseId,
  parseDatabaseIdByName,
} from './deploy-step1-lib.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 跑一次 wrangler 并把输出取回来。
 *
 * 两个必须说清的坑，都会导致**静默的错误结论**：
 *
 *   1. **Windows 上不能直接 `execFileSync('npx.cmd', …)`** —— 它抛 `spawnSync npx.cmd EINVAL`。
 *      第一版就是这么写的，于是所有 wrangler 调用都返回空字符串，"检查是否登录"这一条因此
 *      **永远通过**：脚本以为已经登录，接着去建库。修法是走 `cmd /d /s /c`。
 *   2. **失败必须能被调用方看见。** 空输出与"命令失败"外表一样，但要触发完全不同的处理。
 *      所以这里返回 `{ ok, text }`，而不是一个可能为空的字符串。
 */
interface WranglerResult {
  ok: boolean
  text: string
}

function wrangler(args: string[], { echo = true }: { echo?: boolean } = {}): WranglerResult {
  const isWindows = process.platform === 'win32'
  const file = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npx'
  const argv = isWindows ? ['/d', '/s', '/c', 'npx', 'wrangler', ...args] : ['wrangler', ...args]

  try {
    const output = execFileSync(file, argv, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    if (echo) process.stdout.write(output)
    return { ok: true, text: output }
  } catch (error) {
    const failure = error as {
      stdout?: string | Buffer
      stderr?: string | Buffer
      message?: string
    }
    const text =
      `${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}`.trim() ||
      (failure.message ?? 'wrangler 调用失败，且没有输出')
    if (echo) process.stdout.write(`${text}\n`)
    return { ok: false, text }
  }
}

/** 需要成功的调用。返回空输出即视为"拿不到结论"，直接停下而不是继续猜。 */
function wranglerOrExit(args: string[], what: string, { echo = true } = {}): string {
  const result = wrangler(args, { echo })
  if (!result.ok && result.text.trim().length === 0) {
    console.error('')
    console.error(`${what}失败，而且没有拿到任何输出。`)
    console.error('请确认 Node.js 可用、网络正常，然后重跑 `npm run deploy:step1`。')
    process.exit(1)
  }
  return result.text
}

function step(title: string): void {
  console.log('')
  console.log(`=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// 1. login
// ---------------------------------------------------------------------------
step('1/3 检查 Cloudflare 登录状态')
let whoami = wranglerOrExit(['whoami'], '检查登录状态', { echo: false })
if (/not authenticated/i.test(whoami)) {
  console.log('未登录。正在发起 OAuth 授权，浏览器会弹出授权页。')
  console.log('>> 请在浏览器里点 Allow，然后回到这个窗口等它继续。 <<')
  console.log('')
  wrangler(['login'])
  whoami = wranglerOrExit(['whoami'], '重新检查登录状态', { echo: false })
}
if (/not authenticated/i.test(whoami)) {
  console.error('')
  console.error('仍未登录。请重跑 `npm run deploy:step1` 再试一次；')
  console.error('如果浏览器始终打不开，可以改用 API Token：')
  console.error('  $env:CLOUDFLARE_API_TOKEN = "你的token"')
  process.exit(1)
}
const account = whoami
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.includes('@'))
console.log(`已登录：${account ?? '(已登录，但没解析出账号行)'}`)

// ---------------------------------------------------------------------------
// 2. database
// ---------------------------------------------------------------------------
step('2/3 创建 D1 数据库')
/**
 * `d1 create` is expected to fail when the database already exists, so its failure is handled here
 * rather than treated as fatal. The `d1 list` call that follows is the one that must succeed: it is
 * the only place the id can come from in that case.
 */
const create = wrangler(['d1', 'create', DB_NAME])
let databaseId = create.ok ? parseCreatedDatabaseId(create.text) : null

if (!databaseId) {
  console.log('创建未返回新 id（多半是已经建过），正在查询现有库…')
  const listOutput = wranglerOrExit(['d1', 'list'], '查询现有 D1 数据库', { echo: false })
  databaseId = parseDatabaseIdByName(listOutput, DB_NAME)
  if (!databaseId) {
    // Show what we actually got, so the operator (or whoever helps them) can see the shape.
    console.log('')
    console.log('`wrangler d1 list` 的输出如下：')
    console.log(listOutput.trim().slice(0, 2000))
  }
}

if (!databaseId) {
  console.error('')
  console.error(`找不到 ${DB_NAME} 的 database_id。请把上面的完整输出发给协助你的人。`)
  process.exit(1)
}
console.log(`database_id = ${databaseId}`)

// ---------------------------------------------------------------------------
// 3. wrangler.toml
// ---------------------------------------------------------------------------
step('3/3 把 database_id 写进 wrangler.toml')
const tomlPath = join(root, 'wrangler.toml')
const original = readFileSync(tomlPath, 'utf8')
const applied = applyDatabaseId(original, databaseId)

if (!applied.toml.includes(`database_id = "${databaseId}"`)) {
  console.error('写入看起来没生效。请把 wrangler.toml 的 [[d1_databases]] 段发给协助你的人。')
  process.exit(1)
}
if (applied.toml === original) {
  console.log(`已经是对的（分支 ${applied.branch}），未改动文件。`)
} else {
  writeFileSync(tomlPath, applied.toml, 'utf8')
  console.log(`写入成功（分支 ${applied.branch}）。`)
}

// ---------------------------------------------------------------------------
step('第 1 步完成')
console.log(`  database_id = ${databaseId}`)
console.log('')
console.log('接下来两步由你执行：')
console.log('')
console.log('  # 建表')
console.log('  npm run db:migrate')
console.log('')
console.log('  # 设审阅台口令（会让你粘贴一串长口令，建议 24 位以上）')
console.log('  npx wrangler secret put ADMIN_TOKEN')
console.log('')
console.log('做完后把结果发给我，我接着做部署与自检。')
