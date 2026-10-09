import type { D1Like, D1PreparedStatementLike, D1Result } from '../../worker/env.ts'

/**
 * 测试用的内存 D1 替身。
 *
 * 为什么手写而不是用 `@cloudflare/vitest-pool-workers`：那个包会把整个 vitest 跑进 workerd 里，
 * 对一个只用到几条固定 SQL 的 Worker 来说是很大的复杂度换取很小的收益——而且它会改变所有测试的
 * 运行环境。这里只实现 Worker 真正用到的那些语句形态，**并且对不认识的语句直接抛错**。
 *
 * 最后这一点是关键设计：一个"默默返回空结果"的替身会让 SQL 里的拼写错误伪装成"没有数据"，
 * 于是测试全绿而线上是坏的。宁可炸掉。
 */

type Row = Record<string, unknown>

interface Table {
  rows: Row[]
  /** 唯一约束：列名 -> 已用值。用于模拟 `INSERT OR IGNORE` 的幂等语义。 */
  unique: Map<string, Set<string>>
}

export interface FakeD1Options {
  /** 预置邀请码。测试里几乎每一条都需要一个可用码。 */
  invites?: {
    id: string
    code: string
    label?: string
    max_uses?: number
    uses?: number
    active?: number
    expires_at?: string | null
  }[]
  /** 让某些表"不存在"，用来测试部署自检。 */
  missingTables?: string[]
}

export interface FakeD1 extends D1Like {
  /** 直接读表，供测试断言。 */
  dump(table: 'submissions' | 'invite_codes'): Row[]
  /** 记录所有执行过的 SQL，供"必须走索引"这类断言使用。 */
  readonly log: string[]
}

const UNIQUE_COLUMNS: Record<string, string[]> = {
  submissions: ['id', 'client_submission_id'],
  invite_codes: ['id', 'code'],
}

function matchesWhere(row: Row, clause: string, params: unknown[]): boolean {
  // Supports the two shapes the Worker actually emits: "col = ?N" and "withdrawn = 0".
  const equality = /^(\w+)\s*=\s*\?(\d+)$/.exec(clause.trim())
  if (equality) {
    const column = equality[1] ?? ''
    const value = params[Number(equality[2]) - 1]
    return row[column] === value
  }
  const literal = /^(\w+)\s*=\s*(\d+)$/.exec(clause.trim())
  if (literal) {
    const column = literal[1] ?? ''
    return row[column] === Number(literal[2])
  }
  throw new Error(`内存 D1 替身不认识的 WHERE 子句：${clause}`)
}

/**
 * Cut `condition` out of a statement, stopping before ORDER BY / LIMIT / OFFSET.
 *
 * Getting this wrong is subtle and was caught by a failing test rather than by reading the code:
 * an earlier version matched `WHERE (.+)$` for statements with no WHERE at all and produced the
 * string ``"ORDER BY received_at DESC LIMIT ?1 OFFSET ?2"`` as a single "clause", which then
 * silently matched nothing. The list came back empty and looked like "no submissions" instead of
 * "the stub is wrong".
 */
function extractClauses(sql: string): string[] {
  const where = /\bWHERE\b(.+?)(?:\bORDER BY\b|\bLIMIT\b|\bGROUP BY\b|$)/i.exec(sql)
  if (!where?.[1]) return []
  return where[1]
    .split(/\s+AND\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

/**
 * Collapse `?N` placeholders to position, so that `resolved[N - 1]` is what the SQL's `?N` refers to.
 *
 * Three things matter here, all of them found by failing tests rather than by reading the code:
 *
 *   1. **`?N` is an absolute index into the bound array, not a position in the SQL text.** The Worker
 *      writes `... WHERE withdrawn = 0 LIMIT ?1 OFFSET ?2` and binds two values, so `?1` is the
 *      *first* bound parameter even though it appears second in the text.
 *   2. **Bare `?` placeholders auto-increment alongside numbered ones.** The 14-value INSERT uses
 *      anonymous placeholders; a version that only expanded `?N` left every parameter `undefined`,
 *      so the insert silently never landed and tests reported "no submissions" instead of "the stub
 *      is broken".
 *   3. **No wrapping.** An earlier version wrote `bound[(index - 1) % bound.length]`, which made the
 *      tenth `?10` map back to the first bound value — the right answer for `?1` and the wrong one
 *      for `?10`, which is exactly the kind of bug that looks like a production defect.
 *
 * An index past the end yields `undefined` on purpose: a wrong value fails loudly in an assertion,
 * which is much easier to diagnose than a silently skipped row.
 */
function resolveParams(sql: string, bound: readonly unknown[]): unknown[] {
  const resolved: unknown[] = []
  let nextAnonymous = 1
  for (const match of sql.matchAll(/\?(\d*)/g)) {
    const explicit = match[1]
    const index = explicit ? Number(explicit) : nextAnonymous
    nextAnonymous = Math.max(nextAnonymous, index + 1)
    resolved[index - 1] = bound[index - 1]
  }
  return resolved
}

export function createFakeD1(options: FakeD1Options = {}): FakeD1 {
  const tables = new Map<string, Table>()
  const log: string[] = []
  const missing = new Set(options.missingTables ?? [])

  for (const name of ['submissions', 'invite_codes']) {
    tables.set(name, { rows: [], unique: new Map() })
  }

  for (const invite of options.invites ?? []) {
    tables.get('invite_codes')?.rows.push({
      id: invite.id,
      code: invite.code,
      label: invite.label ?? '',
      max_uses: invite.max_uses ?? 0,
      uses: invite.uses ?? 0,
      active: invite.active ?? 1,
      expires_at: invite.expires_at ?? null,
      created_at: '2026-10-01T00:00:00.000Z',
    })
  }

  function tableOf(name: string): Table {
    if (missing.has(name)) throw new Error(`no such table: ${name}`)
    const table = tables.get(name)
    if (!table) throw new Error(`内存 D1 替身没有这张表：${name}`)
    return table
  }

  function primaryTableName(sql: string): string {
    const match = /\b(?:FROM|INTO|UPDATE)\s+(\w+)/i.exec(sql)
    if (!match?.[1]) throw new Error(`内存 D1 替身无法从这条语句里找出表名：${sql}`)
    return match[1]
  }

  function runStatement(sql: string, bound: readonly unknown[]): D1Result<Row> {
    const normalised = sql.replace(/\s+/g, ' ').trim()
    log.push(normalised)
    const params = resolveParams(normalised, bound)
    const name = primaryTableName(normalised)

    if (/^SELECT COUNT\(\*\) AS total FROM/i.test(normalised)) {
      const table = tableOf(name)
      const clauses = extractClauses(normalised)
      const rows = table.rows.filter((row) =>
        clauses.every((clause) => matchesWhere(row, clause, params)),
      )
      return {
        success: true,
        results: [{ total: rows.length }],
        meta: { rows_read: table.rows.length },
      }
    }

    if (/^SELECT COUNT\(\*\) AS n FROM/i.test(normalised)) {
      const table = tableOf(name)
      return {
        success: true,
        results: [{ n: table.rows.length }],
        meta: { rows_read: table.rows.length },
      }
    }

    if (/^SELECT \* FROM .* WHERE id = \?1$/i.test(normalised)) {
      const table = tableOf(name)
      const row = table.rows.find((entry) => entry.id === params[0])
      return { success: true, results: row ? [row] : [], meta: { rows_read: table.rows.length } }
    }

    if (
      /^SELECT id, code, label, max_uses, uses, active, expires_at FROM invite_codes WHERE code = \?1$/i.test(
        normalised,
      )
    ) {
      const table = tableOf(name)
      const row = table.rows.find((entry) => entry.code === params[0])
      return { success: true, results: row ? [row] : [], meta: { rows_read: table.rows.length } }
    }

    if (
      /^SELECT id, received_at, assessed_at, invite_label, contact_kind, contact_value, decision_label, withdrawn, summary, summary_version FROM submissions/i.test(
        normalised,
      )
    ) {
      const table = tableOf(name)
      const clauses = extractClauses(normalised)
      let rows = table.rows.filter((row) =>
        clauses.every((clause) => matchesWhere(row, clause, params)),
      )
      rows = [...rows].sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))
      // LIMIT/OFFSET are the last two placeholders in the statement.
      const limitIndex = Number(/\bLIMIT\s+\?(\d+)/i.exec(normalised)?.[1] ?? '0')
      const offsetIndex = Number(/\bOFFSET\s+\?(\d+)/i.exec(normalised)?.[1] ?? '0')
      const limit = limitIndex > 0 ? Number(params[limitIndex - 1] ?? 20) : 20
      const offset = offsetIndex > 0 ? Number(params[offsetIndex - 1] ?? 0) : 0
      const page = rows.slice(offset, offset + limit)
      return { success: true, results: page, meta: { rows_read: table.rows.length } }
    }

    if (/^INSERT OR IGNORE INTO submissions/i.test(normalised)) {
      const table = tableOf(name)
      const [id, clientSubmissionId] = params as [string, string]
      for (const column of UNIQUE_COLUMNS.submissions ?? []) {
        const value =
          column === 'id' ? id : column === 'client_submission_id' ? clientSubmissionId : undefined
        if (value === undefined) continue
        const used = table.unique.get(column) ?? new Set<string>()
        if (used.has(value)) {
          return { success: true, results: [], meta: { changes: 0 } }
        }
        used.add(value)
        table.unique.set(column, used)
      }
      table.rows.push({
        id,
        client_submission_id: clientSubmissionId,
        invite_code_id: params[2],
        invite_label: params[3],
        contact_kind: params[4],
        contact_value: params[5],
        received_at: params[6],
        assessed_at: params[7],
        question_pack_id: params[8],
        question_pack_version: params[9],
        scoring_version: params[10],
        role_model_version: params[11],
        payload: params[12],
        summary: params[13],
        summary_version: params[14],
        decision_label: null,
        decision_reason: null,
        decision_at: null,
        withdrawn: 0,
      })
      return { success: true, results: [], meta: { changes: 1 } }
    }

    if (/^UPDATE invite_codes SET uses = uses \+ 1 WHERE id = \?1$/i.test(normalised)) {
      const table = tableOf(name)
      const row = table.rows.find((entry) => entry.id === params[0])
      if (row) row.uses = Number(row.uses) + 1
      return { success: true, results: [], meta: { changes: row ? 1 : 0 } }
    }

    if (
      /^UPDATE submissions SET decision_label = \?1, decision_reason = \?2, decision_at = \?3 WHERE id = \?4$/i.test(
        normalised,
      )
    ) {
      const table = tableOf(name)
      const row = table.rows.find((entry) => entry.id === params[3])
      if (!row) return { success: true, results: [], meta: { changes: 0 } }
      row.decision_label = params[0]
      row.decision_reason = params[1]
      row.decision_at = params[2]
      return { success: true, results: [], meta: { changes: 1 } }
    }

    if (
      /^UPDATE submissions SET summary = \?1, summary_version = \?2 WHERE id = \?3$/i.test(
        normalised,
      )
    ) {
      const table = tableOf(name)
      const row = table.rows.find((entry) => entry.id === params[2])
      if (!row) return { success: true, results: [], meta: { changes: 0 } }
      row.summary = params[0]
      row.summary_version = params[1]
      return { success: true, results: [], meta: { changes: 1 } }
    }

    if (/^UPDATE submissions SET withdrawn = 1 WHERE id = \?1$/i.test(normalised)) {
      const table = tableOf(name)
      const row = table.rows.find((entry) => entry.id === params[0])
      if (!row) return { success: true, results: [], meta: { changes: 0 } }
      row.withdrawn = 1
      return { success: true, results: [], meta: { changes: 1 } }
    }

    throw new Error(
      `内存 D1 替身不认识这条语句（请补上实现，不要让测试悄悄跳过它）：\n${normalised}`,
    )
  }

  function makeStatement(sql: string, bound: unknown[]): D1PreparedStatementLike {
    return {
      bind(...values: unknown[]) {
        return makeStatement(sql, values)
      },
      async first<T = unknown>(column?: string): Promise<T | null> {
        const result = runStatement(sql, bound)
        const row = result.results?.[0]
        if (row === undefined) return null
        if (column) return (row[column] ?? null) as T
        return row as T
      },
      async run(): Promise<D1Result<unknown>> {
        return runStatement(sql, bound)
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const result = runStatement(sql, bound)
        return { ...result, results: (result.results ?? []) as T[] }
      },
    }
  }
  return {
    prepare(query: string) {
      return makeStatement(query, [])
    },
    async batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = []
      for (const statement of statements) {
        const result = await statement.run()
        out.push({ ...result, results: (result.results ?? []) as T[] })
      }
      return out
    },
    dump(table) {
      return [...(tables.get(table)?.rows ?? [])]
    },
    log,
  }
}
