/**
 * 创建邀请码 —— `npm run db:invite -- --label "2026春-社会学-第一批"`
 *
 * 用 wrangler CLI 往远端 D1 写一行。放在脚本里而不是让人手写 SQL，是因为邀请码是**唯一**的
 * 写入闸门：一个拼错的 INSERT 会让整批链接失效，而错误信息只会是"邀请码无效"。
 *
 * 用法：
 *   npm run db:invite                                  # 随机码，不限次数，不过期
 *   npm run db:invite -- --label "第一批" --max-uses 30
 *   npm run db:invite -- --code MY-CUSTOM-CODE --days 14
 *   npm run db:invite -- --local                       # 只写本地开发库
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

function parseArgs(argv: string[]): Options {
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
 * 128 bits of entropy, base32-ish and grouped for humans.
 *
 * The code travels inside a URL that gets pasted into chats and emails, so it has to survive being
 * copied by hand: no ambiguous characters (`0/O`, `1/I/L`), and dashes every four characters so a
 * reader can see whether the whole thing arrived.
 */
function generateCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(20)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out.match(/.{1,4}/g)?.join('-') ?? out
}

const options = parseArgs(process.argv.slice(2))
const code = options.code ?? generateCode()
const now = new Date()
const expiresAt =
  options.days === null ? null : new Date(now.getTime() + options.days * 86_400_000).toISOString()

const id = `inv_${randomBytes(8).toString('hex')}`

// Every value is passed through a bound parameter rather than interpolated into the SQL string, so
// a label containing a quote cannot become part of the statement.
const sql =
  `INSERT INTO invite_codes (id, code, label, max_uses, uses, active, expires_at, created_at) ` +
  `VALUES ('${id}', '${code.replace(/'/g, "''")}', '${options.label.replace(/'/g, "''")}', ` +
  `${Number.isFinite(options.maxUses) ? options.maxUses : 0}, 0, 1, ` +
  `${expiresAt === null ? 'NULL' : `'${expiresAt}'`}, '${now.toISOString()}');`

const args = [
  'wrangler',
  'd1',
  'execute',
  'cohortlens-reviews',
  options.local ? '--local' : '--remote',
  `--command=${sql}`,
]

console.log('写入邀请码…')
console.log(`  码     ${code}`)
console.log(`  批次   ${options.label || '(未标注)'}`)
console.log(`  次数   ${options.maxUses === 0 ? '不限' : options.maxUses}`)
console.log(`  过期   ${expiresAt ?? '不过期'}`)
console.log(`  目标   ${options.local ? '本地 D1' : '远端 D1'}`)
console.log('')

try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  })
} catch {
  console.error('\n写入失败。请确认：')
  console.error('  1. 已经跑过 `npm run db:create` 并把 database_id 填进 wrangler.toml')
  console.error('  2. 已经跑过 `npm run db:migrate` 建表')
  console.error('  3. 已经 `npx wrangler login`')
  process.exit(1)
}

console.log('\n发给作答者的链接形如：')
console.log(`  https://<你的作答端域名>/#/assessment?invite=${code}`)
