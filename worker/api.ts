import {
  SUBMISSION_FORMAT,
  SUBMISSION_FORMAT_VERSION,
  SUBMISSION_NOTICE,
  reviewDecisionLabelSchema,
  submissionRequestSchema,
  type Contact,
  type ReviewSummary,
} from '../src/domain/submission.ts'
import { authenticate, checkInviteRow } from './auth.ts'
import { corsHeaders, decideCors, missingAllowedOrigins } from './cors.ts'
import {
  bumpInviteUses,
  clampPageSize,
  decodePayload,
  findInviteByCode,
  getSubmission,
  insertSubmission,
  listSubmissions,
  missingTables,
  readSummary,
  rewriteSummary,
  saveDecision,
  encodeSummary,
  withdrawSubmission,
} from './db.ts'
import type { ApiError, Env, SubmitResponse } from './env.ts'
import { defaultSubmitLimiter, type RateLimiter } from './rate-limit.ts'
import { deriveSubmissionId, buildDimensionMap, summarizeSubmission } from './review-summary.ts'

/**
 * Worker 路由。
 *
 * 三组端点，敏感度依次上升：
 *
 *   - `GET  /api/health`   部署自检。**不返回任何数据**，只回答"绑定齐了没有"。
 *   - `GET  /api/notice`   提交前须知。让作答端与 Worker 共用同一份文案，避免两边漂移。
 *   - `POST /api/submit`   作答者提交。校验邀请码 + 幂等写入。
 *   - `/api/review/*`      审阅台。全部要求 Bearer 口令。
 *
 * 有意**没有** `DELETE /api/submissions/:id` 的硬删除：撤回是软删（`withdrawn = 1`），
 * 因为"曾经收到过一份材料、后来撤回了"这件事本身需要留下痕迹。硬删只通过运维手段做。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  })
}

function fail(code: string, message: string, hint: string, status: number, origin: string | null) {
  const body: ApiError = { ok: false, code, message, hint }
  return json(body, status, origin)
}

/**
 * 审阅台从 `Authorization` 里取口令；其余端点不需要。
 */
function isReviewPath(pathname: string): boolean {
  return pathname.startsWith('/api/review')
}

export interface HandleApiOptions {
  /**
   * 限流器。默认用模块级单例；测试传入自己的实例，这样"限流生效"可以被单独验证，
   * 而不是让所有其他用例在第十次调用后集体变成 429。
   */
  limiter?: RateLimiter
}

export async function handleApi(
  request: Request,
  env: Env,
  options: HandleApiOptions = {},
): Promise<Response> {
  const limiter = options.limiter ?? defaultSubmitLimiter
  const url = new URL(request.url)
  const pathname = url.pathname
  const requestOrigin = request.headers.get('Origin')
  const cors = decideCors(requestOrigin, env)

  // Preflight. Answered before anything else, including before auth: a browser cannot attach
  // Authorization to a preflight, so requiring it here would break every cross-origin call.
  if (request.method === 'OPTIONS') {
    if (!cors.allowed) {
      return new Response(null, { status: 403, headers: corsHeaders(null) })
    }
    return new Response(null, { status: 204, headers: corsHeaders(cors.origin) })
  }

  if (!cors.allowed) {
    return fail(
      'origin_not_allowed',
      '这个来源没有被允许访问提交接口。',
      missingAllowedOrigins(env) ?? '请确认 ALLOWED_ORIGINS 是否包含作答端的地址。',
      403,
      null,
    )
  }

  // --- health -------------------------------------------------------------
  if (pathname === '/api/health' && request.method === 'GET') {
    const missing = await missingTables(env.DB)
    const originWarning = missingAllowedOrigins(env)
    return json(
      {
        ok: missing.length === 0,
        formatVersion: SUBMISSION_FORMAT_VERSION,
        database: missing.length === 0 ? 'ok' : 'missing_tables',
        missingTables: missing,
        warnings: originWarning ? [originWarning] : [],
        // Deliberately no counts, no ids, no data of any kind: this endpoint is unauthenticated.
      },
      200,
      cors.origin,
    )
  }

  // --- submission notice --------------------------------------------------
  if (pathname === '/api/notice' && request.method === 'GET') {
    return json({ ok: true, notice: SUBMISSION_NOTICE }, 200, cors.origin)
  }

  // --- submit -------------------------------------------------------------
  if (pathname === '/api/submit' && request.method === 'POST') {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return fail(
        'invalid_json',
        '请求体不是合法 JSON。',
        '这通常是客户端版本不匹配，请刷新页面重试。',
        400,
        cors.origin,
      )
    }

    const parsed = submissionRequestSchema.safeParse(raw)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return fail(
        'invalid_submission',
        `提交内容未通过校验：${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : '未知字段错误'}`,
        '如果反复出现，请把这条信息发给发起方；多半是作答端与审阅台版本不一致。',
        400,
        cors.origin,
      )
    }
    const submission = parsed.data

    if (submission.core.formatVersion !== SUBMISSION_FORMAT_VERSION) {
      return fail(
        'format_version_mismatch',
        `提交格式版本 ${submission.core.formatVersion} 与当前接受的 ${SUBMISSION_FORMAT_VERSION} 不一致。`,
        '请让作答者刷新页面后重新提交；如果他已经关闭页面，需要重新做一次测评。',
        409,
        cors.origin,
      )
    }

    /**
     * 限流放在校验**之后**：一个格式错误的请求没有消耗任何服务端资源，不该占用额度。
     * 先记账的写法会让几次失败的尝试把额度吃光，随后一次完全正常的提交拿到 429——
     * 用户看到"提交失败"，而真实原因是他自己前面几次输入错误。
     */
    const clientKey =
      request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'local'
    const limit = limiter.check(clientKey, Date.now())
    if (!limit.allowed) {
      return fail(
        'rate_limited',
        '提交过于频繁。',
        `请等待约 ${limit.retryAfterSeconds} 秒后重试。`,
        429,
        cors.origin,
      )
    }

    const now = new Date().toISOString()
    const inviteRow = await findInviteByCode(env.DB, submission.inviteCode)
    const invite = checkInviteRow(inviteRow, now)
    if (!invite.ok) {
      return fail(
        `invite_${invite.code}`,
        invite.message,
        '请联系发起这次测评的人。',
        403,
        cors.origin,
      )
    }

    const submissionId = deriveSubmissionId(submission.clientSubmissionId, invite.id)
    const contact: Contact = submission.contact

    // The summary is derived here rather than trusted from the client: a client could otherwise
    // submit a payload whose stored summary disagrees with its own contents.
    const summary = summarizeSubmission({
      submissionId,
      receivedAt: now,
      inviteLabel: invite.label,
      contact,
      core: submission.core,
      dimensionOf: buildDimensionMap(submission.core),
    })

    const { inserted } = await insertSubmission(env.DB, {
      id: submissionId,
      clientSubmissionId: submission.clientSubmissionId,
      inviteCodeId: invite.id,
      inviteLabel: invite.label,
      contactKind: contact.kind,
      contactValue: contact.value,
      receivedAt: now,
      assessedAt: submission.core.assessedAt,
      versions: submission.core.versions,
      payload: JSON.stringify(submission.core),
      summary: encodeSummary(summary),
    })

    if (inserted) await bumpInviteUses(env.DB, invite.id)

    const body: SubmitResponse = {
      ok: true,
      submissionId,
      status: inserted ? 'created' : 'existing',
      receivedAt: now,
    }
    return json(body, inserted ? 201 : 200, cors.origin)
  }

  // --- review console -----------------------------------------------------
  if (isReviewPath(pathname)) {
    const auth = authenticate(request, env)
    if (!auth.ok) {
      return fail(
        auth.code,
        auth.message,
        '审阅台口令由部署者通过 wrangler secret 设置。',
        401,
        cors.origin,
      )
    }

    if (pathname === '/api/review/list' && request.method === 'GET') {
      const limit = clampPageSize(Number(url.searchParams.get('limit')))
      const offsetRaw = Number(url.searchParams.get('offset'))
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
      const decision = url.searchParams.get('decision')
      const invite = url.searchParams.get('invite')
      const includeWithdrawn = url.searchParams.get('withdrawn') === '1'

      const { total, rows } = await listSubmissions(env.DB, {
        limit,
        offset,
        decision: decision && decision !== 'all' ? decision : null,
        inviteCodeId: invite,
        includeWithdrawn,
      })

      /**
       * Read each summary through `readSummary`, which upgrades a row written by an older build.
       *
       * The list query deliberately does not select `payload` — not reading it is the whole reason
       * the summary is stored. So when a row turns out to be stale, the payload is fetched **for
       * that row only** and the rebuilt summary is written back. Doing it here rather than leaving it
       * to the detail view matters: a reviewer scanning the list must not see blank rows, because a
       * blank row reads as "this person submitted nothing", which is exactly the wrong conclusion.
       */
      const staleIds: string[] = []
      const items = rows.map((row) => {
        const read = readSummary(row)
        if (read.repairDeferred) staleIds.push(row.id)
        return {
          id: row.id,
          receivedAt: row.received_at,
          assessedAt: row.assessed_at,
          inviteLabel: row.invite_label,
          contactKind: row.contact_kind,
          contactValue: row.contact_value,
          decisionLabel: row.decision_label,
          withdrawn: row.withdrawn === 1,
          summary: read.summary,
          /** Non-null only when a row could not be read even after a repair attempt. */
          summaryError: read.error,
        }
      })

      for (const id of staleIds) {
        const row = await getSubmission(env.DB, id)
        if (!row) continue
        const read = readSummary(row)
        if (!read.summary) continue
        const repaired: ReviewSummary = {
          ...read.summary,
          submissionId: row.id,
          receivedAt: row.received_at,
          assessedAt: row.assessed_at,
          inviteLabel: row.invite_label,
          contact: {
            kind: row.contact_kind === 'phone' ? 'phone' : 'email',
            value: row.contact_value,
          },
          decision: null,
        }
        await rewriteSummary(env.DB, row.id, repaired)
        const target = items.find((item) => item.id === id)
        if (target) {
          target.summary = repaired
          target.summaryError = null
        }
      }

      return json({ ok: true, total, limit, offset, items }, 200, cors.origin)
    }

    const detailMatch = /^\/api\/review\/submission\/([^/]+)$/.exec(pathname)
    if (detailMatch && request.method === 'GET') {
      const id = decodeURIComponent(detailMatch[1] ?? '')
      const row = await getSubmission(env.DB, id)
      if (!row) {
        return fail(
          'not_found',
          '找不到这份提交。',
          '可能是链接过期，或者提交已被删除。',
          404,
          cors.origin,
        )
      }

      const read = readSummary(row)
      if (!read.summary) {
        return fail(
          'summary_unavailable',
          read.error ?? '无法读取这份材料的审阅摘要。',
          '正文仍在库中。请联系维护者用正文重建摘要。',
          500,
          cors.origin,
        )
      }
      /**
       * Re-attach the identity fields the payload does not carry.
       *
       * The decision label is re-validated rather than trusted: only the four allowed values can be
       * written through the API, but a row edited by hand (or by a future build) could hold anything,
       * and passing an unknown string straight through would let an unsupported state render as if it
       * were part of the contract. Anything unrecognised reads back as "not yet reviewed".
       */
      const storedLabel = row.decision_label
      const decisionLabel =
        storedLabel !== null && reviewDecisionLabelSchema.safeParse(storedLabel).success
          ? (storedLabel as NonNullable<ReviewSummary['decision']>['label'])
          : null

      const summary: ReviewSummary = {
        ...read.summary,
        submissionId: row.id,
        receivedAt: row.received_at,
        assessedAt: row.assessed_at,
        inviteLabel: row.invite_label,
        contact: {
          kind: row.contact_kind === 'phone' ? 'phone' : 'email',
          value: row.contact_value,
        },
        decision:
          decisionLabel === null
            ? null
            : {
                label: decisionLabel,
                reason: row.decision_reason ?? '',
                ...(row.decision_at ? { decidedAt: row.decision_at } : {}),
              },
      }
      if (read.needsRewrite) await rewriteSummary(env.DB, row.id, summary)

      return json(
        {
          ok: true,
          summary,
          /** 完整正文，供审阅人核对原始作答。前端默认折叠。 */
          core: decodePayload(row),
          decision: summary.decision,
        },
        200,
        cors.origin,
      )
    }

    const decisionMatch = /^\/api\/review\/submission\/([^/]+)\/decision$/.exec(pathname)
    if (decisionMatch && request.method === 'PATCH') {
      const id = decodeURIComponent(decisionMatch[1] ?? '')
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return fail('invalid_json', '请求体不是合法 JSON。', '', 400, cors.origin)
      }
      const shape = reviewDecisionLabelSchema.safeParse((body as { label?: unknown } | null)?.label)
      if (!shape.success) {
        return fail(
          'invalid_decision',
          '结论标签不在允许集合内。',
          '允许值：undecided / shortlisted / needs_more_info / not_this_round。',
          400,
          cors.origin,
        )
      }
      const reasonRaw = (body as { reason?: unknown }).reason
      const reason = typeof reasonRaw === 'string' ? reasonRaw.slice(0, 2000) : ''
      const row = await getSubmission(env.DB, id)
      if (!row) {
        return fail('not_found', '找不到这份提交。', '', 404, cors.origin)
      }
      const decidedAt = new Date().toISOString()
      const updated = await saveDecision(env.DB, id, shape.data, reason, decidedAt)
      if (!updated) {
        return fail(
          'not_updated',
          '结论没有写入。',
          '请重试；如果持续失败请联系维护者。',
          500,
          cors.origin,
        )
      }
      return json(
        { ok: true, decision: { label: shape.data, reason, decidedAt } },
        200,
        cors.origin,
      )
    }

    const withdrawMatch = /^\/api\/review\/submission\/([^/]+)\/withdraw$/.exec(pathname)
    if (withdrawMatch && request.method === 'POST') {
      const id = decodeURIComponent(withdrawMatch[1] ?? '')
      const updated = await withdrawSubmission(env.DB, id)
      if (!updated) {
        return fail('not_found', '找不到这份提交。', '', 404, cors.origin)
      }
      return json({ ok: true, withdrawn: true }, 200, cors.origin)
    }

    return fail('not_found', '审阅台没有这个端点。', '', 404, cors.origin)
  }

  return fail(
    'not_found',
    `没有这个端点：${pathname}`,
    `当前提交格式版本为 ${SUBMISSION_FORMAT}@${SUBMISSION_FORMAT_VERSION}。`,
    404,
    cors.origin,
  )
}
