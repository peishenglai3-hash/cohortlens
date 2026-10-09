/**
 * 部署第 1 步的**纯逻辑** —— 解析 wrangler 输出、改写 wrangler.toml。
 *
 * 单独一个模块，是因为 `scripts/deploy-step1-cloudflare.ts` 一 import 就会执行部署动作
 * （它会真的跑 wrangler）。把纯函数放在这里，测试就能直接引用它们而不触发任何副作用。
 *
 * 为什么给一个部署脚本写测试：它是整条部署链路上**唯一会修改文件**的一步，而它解析的是另一个
 * 程序的人类可读输出。解析错了只有两种结局——崩溃，或者把错误的 database_id 写进一个随后会被
 * 部署的配置文件里。后者会在几分钟后以一种完全指不到这里的方式失败。
 */

export const DB_NAME = 'cohortlens-reviews'

/**
 * 从 `wrangler d1 create` 的输出里取 `database_id = "..."`。
 *
 * 返回 null 表示"输出里没有新 id"——那是"库已经存在"的正常情况，调用方据此改走 list 查询，
 * 而不是把错误当成失败。
 */
export function parseCreatedDatabaseId(output: string): string | null {
  const match = /database_id\s*=\s*"([0-9a-fA-F-]{36})"/.exec(output)
  return match?.[1] ?? null
}

/**
 * 从 `wrangler d1 list` 的输出里按库名取 uuid。
 *
 * 必须同时支持两种真实格式，因为 wrangler 在不同情况下给的是不同的东西（这一条是被真实输出打
 * 出来的，不是猜的）：
 *
 *   1. **ASCII 表格**（非 TTY 下最常见）：
 *      │ uuid                                 │ name               │ created_at … │
 *      │ ed0a3b50-33c1-4e01-b7a1-7e69c2de471e │ cohortlens-reviews │ 2026-…       │
 *   2. **JSON 数组**（`--json` 或某些版本）：`[{"uuid":"…","name":"…"}]`
 *
 * 表格按**列位置**解析：先从表头行找出 uuid 与 name 两列各自的字符区间，再在数据行里按同样的
 * 区间切。为什么不用"这一行里有 36 位 uuid 就取它"：那会在名字不存在时返回**别人的数据库 id**，
 * 于是部署到一个无关的库上——一个安静且具有破坏性的错误。
 */
export function parseDatabaseIdByName(output: string, name: string): string | null {
  const uuidInRow = (row: string): string | null =>
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(
      row,
    )?.[1] ?? null

  // --- 1. ASCII table -------------------------------------------------------
  const lines = output.split(/\r?\n/).filter((line) => line.includes('│'))
  if (lines.length >= 2) {
    const header = lines[0] ?? ''
    const uuidHeaderAt = header.indexOf('uuid')
    const nameHeaderAt = header.indexOf('name')
    if (uuidHeaderAt >= 0 && nameHeaderAt >= 0) {
      for (const line of lines.slice(1)) {
        // Column widths come from the header, so slicing by those offsets is exact.
        const nameCell = line.slice(nameHeaderAt, nameHeaderAt + 'name'.length + 40)
        if (!nameCell.includes(name)) continue
        const uuidCell = line.slice(uuidHeaderAt, uuidHeaderAt + 40)
        const uuid = uuidInRow(uuidCell)
        if (uuid) return uuid
      }
    }
  }

  // --- 2. JSON --------------------------------------------------------------
  interface Token {
    key: string
    value: string
    index: number
  }
  const seen: Token[] = []
  const tokenPattern = /"(uuid|name|database_name)"\s*:\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(output)) !== null) {
    seen.push({ key: match[1] ?? '', value: match[2] ?? '', index: match.index })
  }

  let lastUuid: string | null = null
  let lastUuidAt = -1
  for (let index = 0; index < seen.length; index += 1) {
    const entry = seen[index]
    if (!entry) continue
    if (entry.key === 'uuid') {
      lastUuid = entry.value
      lastUuidAt = entry.index
      continue
    }
    if (entry.value !== name) continue
    if (lastUuid && entry.index - lastUuidAt < 400) return lastUuid
    const next = seen.slice(index + 1).find((candidate) => candidate.key === 'uuid')
    if (next) return next.value
  }

  return null
}

export type ApplyBranch = 'activated' | 'replaced' | 'appended'

/**
 * 把 id 写进 wrangler.toml。
 *
 * 处理三种输入形态，因为文件可能停在任何一种中间状态：出厂时的注释块、已被手工激活但 id 还是
 * 占位的块、以及完全没有这个段落的文件。分成三种而不是"正则硬套"，是为了让每一种都留下一个
 * 可测的、明确的分支名。
 */
export function applyDatabaseId(
  toml: string,
  databaseId: string,
): { toml: string; branch: ApplyBranch } {
  if (toml.includes('# [[d1_databases]]')) {
    const next = toml
      .replace('# [[d1_databases]]', '[[d1_databases]]')
      .replace(/#\s*binding\s*=\s*"DB"/, 'binding = "DB"')
      .replace(/#\s*database_name\s*=\s*"cohortlens-reviews"/, `database_name = "${DB_NAME}"`)
      .replace(/#\s*database_id\s*=\s*"[^"]*"/, `database_id = "${databaseId}"`)
    return { toml: next, branch: 'activated' }
  }

  if (/^database_id\s*=\s*"/m.test(toml)) {
    const next = toml.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${databaseId}"`)
    return { toml: next, branch: 'replaced' }
  }

  const block = `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${DB_NAME}"\ndatabase_id = "${databaseId}"\n`
  return { toml: toml + block, branch: 'appended' }
}
