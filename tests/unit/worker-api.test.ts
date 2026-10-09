import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  SUBMISSION_FORMAT,
  SUBMISSION_FORMAT_VERSION,
  type SubmissionCore,
  type SubmissionRequest,
} from '../../src/domain/submission.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import { createFakeD1 } from '../fixtures/fake-d1.ts'
import { handleApi } from '../../worker/api.ts'
import type { Env } from '../../worker/env.ts'
import { RateLimiter } from '../../worker/rate-limit.ts'

/**
 * Worker 契约测试。
 *
 * 这些用例覆盖的是**跨信任边界**的行为，因此它们问的问题与引擎测试不同：不是"算得对不对"，
 * 而是"陌生人在公网上能拿它做什么"。
 *
 * 最重要的四类：
 *   1. 没有有效邀请码写不进任何东西；
 *   2. 没有口令读不到任何提交；
 *   3. 重复提交（网络重试）不会产生第二条记录；
 *   4. 审阅台接口在任何情况下都不回显口令。
 */

const bundle = loadContentBundle()
const FIXED_TIME = '2026-10-09T12:00:00.000Z'
const ADMIN_TOKEN = 'test-admin-token-that-is-long-enough-1234'
const GOOD_INVITE = 'INVITE-GOOD-2026'

function completedRun(seed: string) {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `sess_${seed}`,
    createdAt: FIXED_TIME,
  })
  const answers = simulateAnswers(paperQuestions(bundle, created.session), seed)
  return completeAssessment(bundle, { ...created.session, answers }, { generatedAt: FIXED_TIME })
}

function coreFor(seed: string): SubmissionCore {
  const { session, result } = completedRun(seed)
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    submittedAt: FIXED_TIME,
    assessedAt: session.completedAt ?? session.updatedAt,
    versions: {
      questionPackId: session.questionPackId,
      questionPackVersion: session.questionPackVersion,
      scoringVersion: session.scoringVersion,
      roleModelVersion: session.roleModelVersion,
    },
    session,
    result,
  }
}

function submissionFor(
  seed: string,
  overrides: Partial<SubmissionRequest> = {},
): SubmissionRequest {
  return {
    format: SUBMISSION_FORMAT,
    clientSubmissionId: crypto.randomUUID(),
    inviteCode: GOOD_INVITE,
    contact: { kind: 'email', value: 'respondent@example.com' },
    core: coreFor(seed),
    consent: true,
    ...overrides,
  }
}

function makeEnv(fake: ReturnType<typeof createFakeD1>, overrides: Partial<Env> = {}): Env {
  return {
    // The stub implements exactly the D1 surface the Worker uses; `D1Database` here is this
    // project's structural type from `worker/env.ts`, not Cloudflare's global (see that file).
    DB: fake,
    ADMIN_TOKEN,
    ALLOWED_ORIGINS: 'https://app.example.com',
    ...overrides,
  }
}

/**
 * 每条用例一个**新的**限流器。
 *
 * 这是被一次集体失败逼出来的：Worker 默认用的是模块级限流器，而它按 10 次/分钟计数。
 * 31 条用例跑在同一个模块实例上，于是从第 11 次提交开始，后面每条用例都拿到 429——
 * 而失败信息看起来像"提交接口坏了"，完全指不到真正的原因。真正要测限流的用例自己传一个
 * 严格实例，其余用例用宽松的，互不干扰。
 */
function permissiveLimiter(): RateLimiter {
  return new RateLimiter({ windowMs: 60_000, maxPerWindow: 10_000 })
}

function submitRequest(
  body: unknown,
  env: Env,
  origin = 'https://app.example.com',
  limiter: RateLimiter = permissiveLimiter(),
): Promise<Response> {
  return handleApi(
    new Request('https://review.example.com/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    }),
    env,
    { limiter },
  )
}

function reviewRequest(path: string, env: Env, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  return handleApi(new Request(`https://review.example.com${path}`, { headers }), env)
}

describe('worker — /api/health 只回答绑定状态，不泄露数据', () => {
  it('reports ok when both tables exist', async () => {
    const env = makeEnv(createFakeD1())
    const response = await handleApi(new Request('https://review.example.com/api/health'), env)
    const body = (await response.json()) as { ok: boolean; database: string; warnings: string[] }
    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.database).toBe('ok')
    expect(body.warnings).toEqual([])
  })

  it('names the tables that are missing rather than failing opaquely', async () => {
    const env = makeEnv(createFakeD1({ missingTables: ['submissions'] }))
    const response = await handleApi(new Request('https://review.example.com/api/health'), env)
    const body = (await response.json()) as { ok: boolean; missingTables: string[] }
    expect(body.ok).toBe(false)
    expect(body.missingTables).toContain('submissions')
  })

  it('warns when ALLOWED_ORIGINS is unset, because that silently breaks every submission', async () => {
    const env = makeEnv(createFakeD1(), { ALLOWED_ORIGINS: '' })
    const response = await handleApi(new Request('https://review.example.com/api/health'), env)
    const body = (await response.json()) as { warnings: string[] }
    expect(body.warnings.join(' ')).toContain('ALLOWED_ORIGINS')
  })

  it('carries no counts, ids or submission data', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    await submitRequest(submissionFor('health-privacy'), env)
    const response = await handleApi(new Request('https://review.example.com/api/health'), env)
    const text = await response.text()
    expect(text).not.toContain('respondent@example.com')
    expect(text).not.toContain('inv_1')
    expect(text).not.toContain('submissions":')
  })
})

describe('worker — 邀请码是唯一的写入闸门', () => {
  it('accepts a valid invite and stores exactly one row', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE, label: '第一批' }] })
    const env = makeEnv(fake)
    const response = await submitRequest(submissionFor('invite-ok'), env)
    const body = (await response.json()) as { ok: boolean; status: string; submissionId: string }
    expect(response.status).toBe(201)
    expect(body.ok).toBe(true)
    expect(body.status).toBe('created')
    expect(fake.dump('submissions')).toHaveLength(1)
    expect(fake.dump('submissions')[0]?.invite_label).toBe('第一批')
    expect(fake.dump('invite_codes')[0]?.uses).toBe(1)
  })

  it('rejects an unknown code without writing anything', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const response = await submitRequest(
      submissionFor('invite-bad', { inviteCode: 'NOT-A-REAL-CODE' }),
      env,
    )
    const body = (await response.json()) as { ok: boolean; code: string }
    expect(response.status).toBe(403)
    expect(body.ok).toBe(false)
    expect(body.code).toBe('invite_not_found')
    expect(fake.dump('submissions')).toHaveLength(0)
  })

  it('rejects a deactivated code', async () => {
    const fake = createFakeD1({
      invites: [{ id: 'inv_1', code: GOOD_INVITE, active: 0 }],
    })
    const env = makeEnv(fake)
    const body = (await (await submitRequest(submissionFor('invite-off'), env)).json()) as {
      code: string
    }
    expect(body.code).toBe('invite_inactive')
    expect(fake.dump('submissions')).toHaveLength(0)
  })

  it('rejects an expired code', async () => {
    const fake = createFakeD1({
      invites: [{ id: 'inv_1', code: GOOD_INVITE, expires_at: '2020-01-01T00:00:00.000Z' }],
    })
    const env = makeEnv(fake)
    const body = (await (await submitRequest(submissionFor('invite-exp'), env)).json()) as {
      code: string
    }
    expect(body.code).toBe('invite_expired')
  })

  it('rejects a code whose allowance is used up', async () => {
    const fake = createFakeD1({
      invites: [{ id: 'inv_1', code: GOOD_INVITE, max_uses: 2, uses: 2 }],
    })
    const env = makeEnv(fake)
    const body = (await (await submitRequest(submissionFor('invite-used'), env)).json()) as {
      code: string
      message: string
    }
    expect(body.code).toBe('invite_exhausted')
    expect(body.message).toContain('次数已经用完')
    expect(fake.dump('submissions')).toHaveLength(0)
  })
})

describe('worker — 幂等：网络重试不会变成第二份材料', () => {
  it('returns the same submission id and does not double-insert', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const payload = submissionFor('idempotent')

    const first = await submitRequest(payload, env)
    const second = await submitRequest(payload, env)

    const firstBody = (await first.json()) as { status: string; submissionId: string }
    const secondBody = (await second.json()) as { status: string; submissionId: string }

    expect(first.status).toBe(201)
    expect(firstBody.status).toBe('created')
    expect(second.status).toBe(200)
    expect(secondBody.status).toBe('existing')
    expect(secondBody.submissionId).toBe(firstBody.submissionId)
    expect(fake.dump('submissions')).toHaveLength(1)
  })

  it('counts the invite only once across retries', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const payload = submissionFor('idempotent-uses')
    await submitRequest(payload, env)
    await submitRequest(payload, env)
    expect(fake.dump('invite_codes')[0]?.uses).toBe(1)
  })

  it('treats a different client id as a genuinely different submission', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    await submitRequest(submissionFor('same-person-a'), env)
    await submitRequest(submissionFor('same-person-b'), env)
    expect(fake.dump('submissions')).toHaveLength(2)
  })
})

describe('worker — 提交体内不可信', () => {
  it('rejects a payload that fails the contract', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    const bad = { ...submissionFor('bad-shape'), consent: false }
    const response = await submitRequest(bad, env)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { code: string }
    expect(body.code).toBe('invalid_submission')
  })

  it('rejects a missing contact instead of storing an unattributable row', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    const bad = submissionFor('no-contact') as unknown as Record<string, unknown>
    delete bad.contact
    const response = await submitRequest(bad, env)
    expect(response.status).toBe(400)
  })

  it('rejects a non-JSON body', async () => {
    const env = makeEnv(createFakeD1())
    const response = await handleApi(
      new Request('https://review.example.com/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'https://app.example.com' },
        body: 'not json at all',
      }),
      env,
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe('invalid_json')
  })

  it('never trusts a summary supplied by the client', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)

    /**
     * A hostile or stale client tries to smuggle a pre-baked summary in alongside the real fields.
     * The contract is `.strict()`, so this is **rejected** rather than quietly ignored — and that is
     * the behaviour worth pinning: a server that silently drops unknown fields would still be
     * correct here, but a server that *merged* them would let a client dictate what the reviewer
     * sees. Refusing is the version that cannot be misused.
     */
    const forged = submissionFor('server-side-summary') as unknown as Record<string, unknown>
    forged.summary = { submissionId: 'forged', material: { answeredItems: 999 } }

    const response = await submitRequest(forged, env)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { code: string; message: string }
    expect(body.code).toBe('invalid_submission')
    expect(body.message).toContain('summary')
    expect(fake.dump('submissions')).toHaveLength(0)
  })

  it('derives the stored summary from the real run, not from anything the client could set', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    await submitRequest(submissionFor('derived-summary'), env)

    // Stored summaries are wrapped in a versioned envelope so a future shape change can be detected
    // on read and repaired (see the "旧版摘要会被自愈" suite below).
    const row = fake.dump('submissions')[0]
    // The shape version lives in its own column, not inside the JSON: the list query does not read
    // `payload`, so it needs a cheap way to spot a row written by an older build.
    expect(Number(row?.summary_version)).toBeGreaterThan(0)

    const stored = JSON.parse(String(row?.summary)) as {
      material: { answeredItems: number; totalItems: number; completionRatio: number }
      submissionId: string
      decision: unknown
    }
    // Every number must be internally consistent with the run that was actually submitted.
    expect(stored.material.answeredItems).toBe(stored.material.totalItems)
    expect(stored.material.completionRatio).toBe(1)
    expect(stored.submissionId).not.toBe('forged')
    // And a freshly stored summary never carries a decision — review starts from "undecided".
    expect(stored.decision).toBeNull()
  })

  it('rejects a submission whose format version the server does not understand', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    const payload = submissionFor('old-format')
    const stale = {
      ...payload,
      core: { ...payload.core, formatVersion: '0.9' },
    }
    const response = await submitRequest(stale, env)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { code: string }).code).toBe('format_version_mismatch')
  })
})

describe('worker — 旧版摘要会被自愈，而不是让详情页白屏', () => {
  it('re-derives a stored summary written by an older build and writes it back', async () => {
    /**
     * The bug this pins down: summaries are derived at write time and stored. Adding a field to the
     * summary shape (here: `material.coverage`) left every previously stored row missing it, and the
     * console died with "Cannot read properties of undefined (reading 'map')" on the detail view
     * while the list view looked fine.
     *
     * The fix versions the stored summary and rebuilds it from the payload on read. This test seeds
     * a row in the OLD shape on purpose and asserts both that the read succeeds and that the repair
     * was persisted.
     */
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const created = (await (await submitRequest(submissionFor('heal-me'), env)).json()) as {
      submissionId: string
    }

    const row = fake.dump('submissions').find((entry) => entry.id === created.submissionId)
    expect(row).toBeTruthy()
    const payload = String(row?.payload)

    // Rewrite the stored summary into the pre-versioning shape: a bare summary object with no
    // `coverage` and no version envelope, exactly what an older build left behind.
    // Simulate the pre-versioning shape: version 1, and a `material` block without `coverage`.
    const legacySummary = {
      material: {
        answeredItems: 1,
        totalItems: 1,
        completionRatio: 1,
        thinDimensions: [],
        needsFurtherUnderstanding: false,
      },
    }
    row!.summary = JSON.stringify(legacySummary)
    row!.summary_version = 1

    const response = await reviewRequest(
      `/api/review/submission/${encodeURIComponent(created.submissionId)}`,
      env,
      ADMIN_TOKEN,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      summary: { material: { coverage: unknown[] } }
    }
    // The rebuilt summary must carry the field the console needs, rather than being absent.
    expect(Array.isArray(body.summary.material.coverage)).toBe(true)
    expect(body.summary.material.coverage.length).toBeGreaterThan(0)

    // And the repair is persisted, so the next read is a plain hit.
    expect(Number(row?.summary_version)).toBeGreaterThan(1)
    expect(String(row?.summary)).toContain('coverage')
    expect(payload.length).toBeGreaterThan(0)
  })
})

describe('worker — 审阅台必须持口令', () => {
  it('refuses every review endpoint without a token', async () => {
    const env = makeEnv(createFakeD1())
    for (const path of ['/api/review/list', '/api/review/submission/anything']) {
      const response = await reviewRequest(path, env)
      expect(response.status, path).toBe(401)
    }
  })

  it('refuses a wrong token', async () => {
    const env = makeEnv(createFakeD1())
    const response = await reviewRequest(
      '/api/review/list',
      env,
      'wrong-token-but-long-enough-xxxx',
    )
    expect(response.status).toBe(401)
    expect(((await response.json()) as { code: string }).code).toBe('invalid_token')
  })

  it('never echoes the configured token or the supplied one', async () => {
    const env = makeEnv(createFakeD1())
    const response = await reviewRequest('/api/review/list', env, 'a-supplied-token-value')
    const text = await response.text()
    expect(text).not.toContain(ADMIN_TOKEN)
    expect(text).not.toContain('a-supplied-token-value')
  })

  it('fails closed when the server token is too short to be a real secret', async () => {
    const env = makeEnv(createFakeD1(), { ADMIN_TOKEN: 'short' })
    const response = await reviewRequest('/api/review/list', env, 'short')
    expect(response.status).toBe(401)
    const body = (await response.json()) as { code: string; message: string }
    expect(body.code).toBe('server_misconfigured')
    expect(body.message).toContain('ADMIN_TOKEN')
  })

  it('lists submissions with a derived summary once authenticated', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE, label: '第一批' }] })
    const env = makeEnv(fake)
    await submitRequest(submissionFor('list-me'), env)

    const response = await reviewRequest('/api/review/list', env, ADMIN_TOKEN)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      total: number
      items: {
        contactValue: string
        inviteLabel: string
        decisionLabel: string | null
        summary: { material: { answeredItems: number; totalItems: number }; roleFits: unknown[] }
      }[]
    }
    expect(body.ok).toBe(true)
    expect(body.total).toBe(1)
    expect(body.items[0]?.contactValue).toBe('respondent@example.com')
    expect(body.items[0]?.inviteLabel).toBe('第一批')
    expect(body.items[0]?.decisionLabel).toBeNull()
    expect(body.items[0]?.summary.material.answeredItems).toBe(
      body.items[0]?.summary.material.totalItems,
    )
  })

  it('records a human decision and reads it back', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const created = (await (await submitRequest(submissionFor('decide-me'), env)).json()) as {
      submissionId: string
    }

    const patch = await handleApi(
      new Request(
        `https://review.example.com/api/review/submission/${encodeURIComponent(created.submissionId)}/decision`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
          body: JSON.stringify({ label: 'shortlisted', reason: '合作层证据充分，想进一步聊' }),
        },
      ),
      env,
    )
    expect(patch.status).toBe(200)

    const detail = (await (
      await reviewRequest(
        `/api/review/submission/${encodeURIComponent(created.submissionId)}`,
        env,
        ADMIN_TOKEN,
      )
    ).json()) as { decision: { label: string; reason: string } | null }
    expect(detail.decision?.label).toBe('shortlisted')
    expect(detail.decision?.reason).toContain('想进一步聊')
  })

  it('rejects a decision label outside the allowed set', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const created = (await (await submitRequest(submissionFor('bad-label'), env)).json()) as {
      submissionId: string
    }
    const response = await handleApi(
      new Request(
        `https://review.example.com/api/review/submission/${encodeURIComponent(created.submissionId)}/decision`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
          body: JSON.stringify({ label: 'rejected', reason: 'politically unsuitable' }),
        },
      ),
      env,
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe('invalid_decision')
  })

  it('withdraws instead of deleting, so the console can stop showing it', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    const created = (await (await submitRequest(submissionFor('withdraw-me'), env)).json()) as {
      submissionId: string
    }
    await handleApi(
      new Request(
        `https://review.example.com/api/review/submission/${encodeURIComponent(created.submissionId)}/withdraw`,
        { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
      ),
      env,
    )
    expect(fake.dump('submissions')[0]?.withdrawn).toBe(1)
    const list = (await (await reviewRequest('/api/review/list', env, ADMIN_TOKEN)).json()) as {
      total: number
    }
    expect(list.total).toBe(0)
  })
})

describe('worker — CORS 是精确白名单，不是 *', () => {
  it('allows the configured origin and echoes exactly it', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    const response = await submitRequest(submissionFor('cors-ok'), env)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
  })

  it('refuses an origin that merely looks similar', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    for (const origin of [
      'https://app.example.com.evil.test',
      'https://evil-app.example.com',
      'http://app.example.com',
    ]) {
      const response = await submitRequest(submissionFor(`cors-${origin}`), env, origin)
      expect(response.status, origin).toBe(403)
      expect(response.headers.get('Access-Control-Allow-Origin'), origin).toBeNull()
    }
  })

  it('refuses everything when no origin is configured', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }), {
      ALLOWED_ORIGINS: '',
    })
    const response = await submitRequest(submissionFor('cors-none'), env)
    expect(response.status).toBe(403)
    expect(((await response.json()) as { code: string }).code).toBe('origin_not_allowed')
  })

  it('answers a preflight without requiring Authorization', async () => {
    const env = makeEnv(createFakeD1())
    const response = await handleApi(
      new Request('https://review.example.com/api/review/list', {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example.com' },
      }),
      env,
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  })
})

describe('worker — 提交接口有节流', () => {
  it('refuses a burst from one address, and starts refusing at the configured limit', async () => {
    const fake = createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] })
    const env = makeEnv(fake)
    // A deliberately tiny window so the boundary is unambiguous rather than "somewhere after ten".
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 3 })
    const statuses: number[] = []

    for (let index = 0; index < 6; index += 1) {
      const response = await handleApi(
        new Request('https://review.example.com/api/submit', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Origin: 'https://app.example.com',
            'CF-Connecting-IP': '203.0.113.9',
          },
          body: JSON.stringify(submissionFor(`burst-${index}`)),
        }),
        env,
        { limiter },
      )
      statuses.push(response.status)
    }

    expect(statuses.slice(0, 3)).toEqual([201, 201, 201])
    expect(statuses.slice(3)).toEqual([429, 429, 429])
    // The three accepted submissions are the only rows: a throttled request writes nothing.
    expect(fake.dump('submissions')).toHaveLength(3)
  })

  it('tracks addresses separately', async () => {
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 2 })
    const post = (ip: string, seed: string) =>
      handleApi(
        new Request('https://review.example.com/api/submit', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Origin: 'https://app.example.com',
            'CF-Connecting-IP': ip,
          },
          body: JSON.stringify(submissionFor(seed)),
        }),
        env,
        { limiter },
      )

    await post('198.51.100.1', 'ip-a-1')
    await post('198.51.100.1', 'ip-a-2')
    // The first address is now at its limit; a different one must still be served.
    expect((await post('198.51.100.1', 'ip-a-3')).status).toBe(429)
    expect((await post('198.51.100.2', 'ip-b-1')).status).toBe(201)
  })

  it('does not charge a rejected request against the limit', async () => {
    /**
     * This is the defect the ordering fix removed: with the accounting done before validation, a
     * handful of malformed attempts would exhaust the allowance and the respondent's next *valid*
     * submission would be refused with a message about being too fast.
     */
    const env = makeEnv(createFakeD1({ invites: [{ id: 'inv_1', code: GOOD_INVITE }] }))
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 2 })

    for (let index = 0; index < 5; index += 1) {
      const rejected = await submitRequest(
        { nonsense: true },
        env,
        'https://app.example.com',
        limiter,
      )
      expect(rejected.status).toBe(400)
    }
    // Two valid submissions must still fit inside a limit of two.
    const first = await submitRequest(
      submissionFor('after-bad-1'),
      env,
      'https://app.example.com',
      limiter,
    )
    const second = await submitRequest(
      submissionFor('after-bad-2'),
      env,
      'https://app.example.com',
      limiter,
    )
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
  })
})

describe('submission notice is served by the worker so both sides cannot drift', () => {
  it('returns the notice', async () => {
    const env = makeEnv(createFakeD1())
    const response = await handleApi(new Request('https://review.example.com/api/notice'), env)
    const body = (await response.json()) as { ok: boolean; notice: { points: string[] } }
    expect(body.ok).toBe(true)
    expect(body.notice.points.length).toBeGreaterThan(3)
  })
})
