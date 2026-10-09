import type { AssessmentResult, AssessmentSession } from '../src/domain/schemas.ts'
import type { ReviewSummary, SubmissionCore } from '../src/domain/submission.ts'
import type { D1Database } from './env.ts'
import { buildDimensionMap, summarizeSubmission } from './review-summary.ts'

/**
 * D1 读写封装。
 *
 * 两件事在这里被固定下来，因为它们都是"忘了就会在某天安静地变慢或变坏"的类型：
 *
 *   1. **所有列表查询都带索引条件与 LIMIT。** D1 免费版有每日行读上限，全表扫描会把额度烧光。
 *      分页在 SQL 层做，不在 JS 层切片——在 JS 层切片意味着每次列表都把整表读进内存，
 *      行读成本与库大小成正比，而不是与页大小成正比。
 *   2. **幂等写入靠唯一索引，不靠先查后写。** 先 SELECT 再 INSERT 在并发下会双重写入；
 *      这里用 `INSERT OR IGNORE` + 唯一索引，让数据库来保证。
 */

export interface SubmissionRow {
  id: string
  client_submission_id: string
  invite_code_id: string | null
  invite_label: string
  contact_kind: string
  contact_value: string
  received_at: string
  assessed_at: string
  question_pack_id: string
  question_pack_version: string
  scoring_version: string
  role_model_version: string
  payload: string
  summary: string
  decision_label: string | null
  decision_reason: string | null
  decision_at: string | null
  withdrawn: number
}

export interface SubmissionListRow {
  id: string
  received_at: string
  assessed_at: string
  invite_label: string
  contact_kind: string
  contact_value: string
  decision_label: string | null
  withdrawn: number
  summary: string
  summary_version?: number
}

/**
 * 审阅摘要的存储格式版本。
 *
 * 摘要**派生自**提交正文，但它被存下来是为了让列表页不必解析每份几百 KB 的正文。代价是：
 * 摘要的形状一旦演进（例如新增 `material.coverage`），库里已有的摘要是旧形状，读出来就缺字段。
 *
 * 第一次撞上这个问题的表现是**整个详情页白屏**——`Cannot read properties of undefined (reading
 * 'map')`——而列表页本身是好的，所以看起来像界面 bug。根因不在界面，在于"存派生数据却不带版本"。
 *
 * 解法：版本写进存储、读时校验，必要时用正文**重新派生并回写**。旧提交因此会自愈，
 * 不需要一次性迁移，也不需要在界面里到处写 `?? []`——后者只是把问题推到下一次读。
 */
export const SUMMARY_VERSION = 2

export function encodeSummary(summary: ReviewSummary): string {
  return JSON.stringify(summary)
}

export interface ReadSummaryResult {
  summary: ReviewSummary | null
  /** True when the stored copy was an older shape and should be written back. */
  needsRewrite: boolean
  /** Non-null when the summary could not be produced at all. */
  error: string | null
  /** True when the row is stale **and** this query did not carry the payload to repair it with. */
  repairDeferred: boolean
}

/**
 * Read a summary, re-deriving it when the row was written by an older shape.
 *
 * The version lives in its own column, not inside the JSON. That is deliberate: the list query does
 * not select `payload` (avoiding that read is the entire reason the summary is stored), so it needs
 * a cheap way to know a row is stale. An earlier version embedded the version in the JSON envelope
 * and the list page could only conclude "stale, and I cannot fix it here", which surfaced as a
 * blank row rather than as data.
 *
 * The rebuild uses the stored payload, which is the source of truth, so it is a recomputation rather
 * than a guess. `submissionId`/`receivedAt`/`inviteLabel`/`contact` are re-attached by the caller
 * from the row's own columns, because those live outside the payload.
 */
export function readSummary(row: {
  summary: string
  summary_version?: number
  payload?: string
}): ReadSummaryResult {
  const version = row.summary_version ?? 1
  if (version === SUMMARY_VERSION) {
    try {
      return {
        summary: JSON.parse(row.summary) as ReviewSummary,
        needsRewrite: false,
        error: null,
        repairDeferred: false,
      }
    } catch (error) {
      // A row whose version says "current" but whose JSON does not parse is corrupt rather than old;
      // falling through to a rebuild is the most useful thing to do with it.
      void error
    }
  }

  if (!row.payload) {
    return {
      summary: null,
      needsRewrite: true,
      error: '这份材料的审阅摘要由旧版本写入，需要重建；本次查询未携带正文。',
      repairDeferred: true,
    }
  }
  try {
    const core = decodePayload({ payload: row.payload })
    return {
      summary: summarizeSubmission({
        submissionId: '',
        receivedAt: '',
        inviteLabel: '',
        contact: null,
        core,
        dimensionOf: buildDimensionMap(core),
      }),
      needsRewrite: true,
      error: null,
      repairDeferred: false,
    }
  } catch (error) {
    return {
      summary: null,
      needsRewrite: false,
      error: `重建审阅摘要失败：${error instanceof Error ? error.message : String(error)}`,
      repairDeferred: false,
    }
  }
}

/** Write a rebuilt summary back (with its new version) so the next read is a plain hit. */
export async function rewriteSummary(
  db: D1Database,
  id: string,
  summary: ReviewSummary,
): Promise<void> {
  await db
    .prepare('UPDATE submissions SET summary = ?1, summary_version = ?2 WHERE id = ?3')
    .bind(encodeSummary(summary), SUMMARY_VERSION, id)
    .run()
}

export function decodePayload(row: { payload: string }): SubmissionCore {
  return JSON.parse(row.payload) as SubmissionCore
}

// ---------------------------------------------------------------------------
// 邀请码
// ---------------------------------------------------------------------------

export async function findInviteByCode(db: D1Database, code: string) {
  return db
    .prepare(
      'SELECT id, code, label, max_uses, uses, active, expires_at FROM invite_codes WHERE code = ?1',
    )
    .bind(code)
    .first<{
      id: string
      code: string
      label: string
      max_uses: number
      uses: number
      active: number
      expires_at: string | null
    }>()
}

/** 记一次使用。放在提交成功之后调用，避免提交失败也扣次数。 */
export async function bumpInviteUses(db: D1Database, inviteId: string): Promise<void> {
  await db.prepare('UPDATE invite_codes SET uses = uses + 1 WHERE id = ?1').bind(inviteId).run()
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

export interface InsertSubmissionInput {
  id: string
  clientSubmissionId: string
  inviteCodeId: string | null
  inviteLabel: string
  contactKind: string
  contactValue: string
  receivedAt: string
  assessedAt: string
  versions: SubmissionCore['versions']
  payload: string
  summary: string
}

/**
 * 幂等插入。
 *
 * 返回 `inserted: false` 表示这个 `client_submission_id` 之前已经写过——那是客户端重试造成的
 * 重复提交，不是错误，也**不应该**产生第二条记录。调用方据此返回 `existing` 而不是报错。
 */
export async function insertSubmission(
  db: D1Database,
  input: InsertSubmissionInput,
): Promise<{ inserted: boolean }> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO submissions (
         id, client_submission_id, invite_code_id, invite_label,
         contact_kind, contact_value, received_at, assessed_at,
         question_pack_id, question_pack_version, scoring_version, role_model_version,
         payload, summary, summary_version, withdrawn
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0)`,
    )
    .bind(
      input.id,
      input.clientSubmissionId,
      input.inviteCodeId,
      input.inviteLabel,
      input.contactKind,
      input.contactValue,
      input.receivedAt,
      input.assessedAt,
      input.versions.questionPackId,
      input.versions.questionPackVersion,
      input.versions.scoringVersion,
      input.versions.roleModelVersion,
      input.payload,
      input.summary,
      SUMMARY_VERSION,
    )
    .run()
  const changes = result.meta?.changes ?? 0
  return { inserted: changes > 0 }
}

// ---------------------------------------------------------------------------
// 审阅台读取
// ---------------------------------------------------------------------------

export interface ListOptions {
  limit: number
  offset: number
  /** 只看某个审阅状态。`null` 表示不筛。 */
  decision?: string | null
  /** 只看某个批次。 */
  inviteCodeId?: string | null
  /** 是否包含已撤回的提交。默认不包含。 */
  includeWithdrawn?: boolean
}

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export function clampPageSize(raw: number | null): number {
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.floor(raw))
}

/**
 * 列表查询。
 *
 * 条件组合用固定 SQL 而不是拼字符串：`decision` 与 `invite` 各成一个可选谓词，
 * 任何用户输入都只经 `bind()` 传参，不进 SQL 文本。
 */
export async function listSubmissions(db: D1Database, options: ListOptions) {
  const clauses: string[] = []
  const bindings: unknown[] = []
  if (!options.includeWithdrawn) clauses.push('withdrawn = 0')
  if (options.decision) {
    clauses.push(`decision_label = ?${bindings.length + 1}`)
    bindings.push(options.decision)
  }
  if (options.inviteCodeId) {
    clauses.push(`invite_code_id = ?${bindings.length + 1}`)
    bindings.push(options.inviteCodeId)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM submissions ${where}`)
    .bind(...bindings)
    .first<{ total: number }>()

  const limitPlaceholder = `?${bindings.length + 1}`
  const offsetPlaceholder = `?${bindings.length + 2}`
  const rows = await db
    .prepare(
      `SELECT id, received_at, assessed_at, invite_label, contact_kind, contact_value,
              decision_label, withdrawn, summary, summary_version
         FROM submissions ${where}
        ORDER BY received_at DESC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    )
    .bind(...bindings, options.limit, options.offset)
    .all<SubmissionListRow>()

  return {
    total: totalRow?.total ?? 0,
    rows: rows.results ?? [],
  }
}

export async function getSubmission(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM submissions WHERE id = ?1').bind(id).first<SubmissionRow>()
}

/** 写人工结论。只更新结论三列，不碰正文——审阅意见与原始材料必须可以分开审计。 */
export async function saveDecision(
  db: D1Database,
  id: string,
  label: string,
  reason: string,
  decidedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE submissions SET decision_label = ?1, decision_reason = ?2, decision_at = ?3 WHERE id = ?4',
    )
    .bind(label, reason, decidedAt, id)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export async function withdrawSubmission(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE submissions SET withdrawn = 1 WHERE id = ?1')
    .bind(id)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

// ---------------------------------------------------------------------------
// 组合入口（供 Worker 与测试共用）
// ---------------------------------------------------------------------------

export interface BuildSummaryInput {
  submissionId: string
  receivedAt: string
  inviteLabel: string
  contact: { kind: 'email' | 'phone'; value: string } | null
  session: AssessmentSession
  result: AssessmentResult
  versions: SubmissionCore['versions']
  assessedAt: string
}

/** 把"提交正文 + 身份信息"合成一条待入库的记录所需的全部字段。 */
export function buildSubmissionRecord(input: BuildSummaryInput) {
  const core: SubmissionCore = {
    formatVersion: '1.0',
    submittedAt: input.receivedAt,
    assessedAt: input.assessedAt,
    versions: input.versions,
    session: input.session,
    result: input.result,
  }
  const summary = summarizeSubmission({
    submissionId: input.submissionId,
    receivedAt: input.receivedAt,
    inviteLabel: input.inviteLabel,
    contact: input.contact,
    core,
    dimensionOf: buildDimensionMap(core),
  })
  return { core, summary }
}

/** 部署自检用：确认表已建立。返回缺失的表名。 */
export async function missingTables(db: D1Database): Promise<string[]> {
  const missing: string[] = []
  for (const table of ['invite_codes', 'submissions']) {
    try {
      await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
    } catch {
      missing.push(table)
    }
  }
  return missing
}
