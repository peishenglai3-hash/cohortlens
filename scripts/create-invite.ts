/**
 * 创建邀请码 —— `npm run db:invite -- --label "2026春-社会学-第一批"`
 *
 * 用 wrangler 往远端（或本地）D1 写一行。放在脚本里而不是让人手写 SQL，是因为邀请码是**唯一**的
 * 写入闸门：一个拼错的 INSERT 会让整批链接失效，而错误信息只会是"邀请码无效"。
 *
 * 用法：
 *   npm run db:invite                                  # 随机码，不限次数，不过期
 *   npm run db:invite -- --label "第一批" --max-uses 30
 *   npm run db:invite -- --code MY-CUSTOM-CODE --days 14
 *   npm run db:invite -- --local                       # 只写本地开发库
 *
 * Windows 注意：绝不能直接 `execFileSync('npx.cmd', …)`——那会抛 `spawnSync npx.cmd EINVAL`，
 * 而因为它被 catch 住了，表现是**脚本打印了邀请码、退出码 1、但库里什么都没有**。
 * 这个坑和 `scripts/deploy-step1-cloudflare.ts` 里记的是同一个，所以这里走 `cmd /d /s /c`。
 */

import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

interface Options {
  label: string
  code: string | null
  maxUses: number
  days: number | null
  local: boolean
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { label: '', code: null, maxUses: 0, days: null, local: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--label' && next) {
      options.label = next
      index += 1
    } else if (arg === '--code' && next) {
      options.code = next.trim()
      index += 1
    } else if (arg === '--max-uses' && next) {
      options.maxUses = Number(next)
      index += 1
    } else if (arg === '--days' && next) {
      options.days = Number(next)
      index += 1
    } else if (arg === '--local') {
      options.local = true
    }
  }
  return options
}

/**
 * 128 bits of entropy, grouped for humans.
 *
 * The code travels inside a URL that gets pasted into chats and emails, so it has to survive being
 * copied by hand: no ambiguous characters (`0/O`, `1/I/L`), and dashes every four characters so a
 * reader can see whether the whole thing arrived.
 */
export function generateCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(20)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out.match(/.{1,4}/g)?.join('-') ?? out
}

/** Build the INSERT. Values are escaped for SQLite by doubling single quotes. */
export function buildInsertSql(options: Options, code: string, now: Date): string {
  const id = `inv_${randomBytes(8).toString('hex')}`
  const expiresAt =
    options.days === null ? null : new Date(now.getTime() + options.days * 86_400_000).toISOString()
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const maxUses = Number.isFinite(options.maxUses) ? options.maxUses : 0

  return (
    'INSERT INTO invite_codes (id, code, label, max_uses, uses, active, expires_at, created_at) ' +
    `VALUES (${quote(id)}, ${quote(code)}, ${quote(options.label)}, ${maxUses}, 0, 1, ` +
    `${expiresAt === null ? 'NULL' : quote(expiresAt)}, ${quote(now.toISOString())});`
  )
}

/** Run `npx wrangler …`. Returns whether it succeeded, plus the combined output. */
export function runWrangler(args: string[], cwd: string): { ok: boolean; text: string } {
  const isWindows = process.platform === 'win32'
  const file = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npx'
  const argv = isWindows ? ['/d', '/s', '/c', 'npx', 'wrangler', ...args] : ['wrangler', ...args]
  try {
    const output = execFileSync(file, argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    return { ok: true, text: output }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const text = `${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}`.trim()
    return { ok: false, text: text || (failure.message ?? 'wrangler 调用失败') }
  }
}

/**
 * Confirm the row is really there.
 *
 * A write that reports success but did not land is exactly the failure this script just had, so it
 * re-reads instead of trusting the write. "Verified" is worth one extra query here: the whole batch
 * of links depends on the code existing.
 */
function verify(cwd: string, code: string, local: boolean): boolean {
  const args = [
    'd1',
    'execute',
    'cohortlens-reviews',
    local ? '--local' : '--remote',
    '--json',
    `--command=SELECT code FROM invite_codes WHERE code = '${code.replace(/'/g, "''")}';`,
  ]
  const result = runWrangler(args, cwd)
  return result.text.includes(code)
}

async function main(): Promise<void> {
  const { fileURLToPath } = await import('node:url')
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const options = parseArgs(process.argv.slice(2))
  const code = options.code ?? generateCode()
  const now = new Date()
  const sql = buildInsertSql(options, code, now)

  const expiresAt =
    options.days === null
      ? '不过期'
      : new Date(now.getTime() + options.days * 86_400_000).toISOString()

  console.log('写入邀请码…')
  console.log(`  码     ${code}`)
  console.log(`  批次   ${options.label || '(未标注)'}`)
  console.log(`  次数   ${options.maxUses === 0 ? '不限' : options.maxUses}`)
  console.log(`  过期   ${expiresAt}`)
  console.log(`  目标   ${options.local ? '本地 D1' : '远端 D1'}`)
  console.log('')

  const write = runWrangler(
    [
      'd1',
      'execute',
      'cohortlens-reviews',
      options.local ? '--local' : '--remote',
      `--command=${sql}`,
    ],
    cwd,
  )
  if (!write.ok || /ERROR/i.test(write.text)) {
    console.error(write.text)
    console.error('写入失败。请确认：')
    console.error(
      '  1. 已经跑过 `npm run deploy:step1`（它负责建库并把 database_id 写进 wrangler.toml）',
    )
    console.error('  2. 已经跑过 `npm run db:migrate`（建表）')
    console.error('  3. 已经登录：`npx wrangler whoami`')
    process.exit(1)
  }

  if (!verify(cwd, code, options.local)) {
    console.error('')
    console.error('写入命令报告成功，但回读时找不到这个码。')
    console.error('这通常意味着写到了另一个库；请把上面的输出发给协助你的人。')
    process.exit(1)
  }

  console.log('已写入并回读确认。')
  console.log('')
  console.log('发给作答者的链接形如：')
  console.log(`  https://cohortlens.pages.dev/#/assessment?invite=${code}`)
  console.log('')
  console.log('审阅台：')
  console.log('  https://cohortlens-review.peishenglai3.workers.dev/')
}

// Only run when invoked as a script, so the helpers above stay unit-testable.
if (process.argv[1] && /create-invite/.test(process.argv[1])) {
  void main()
}
