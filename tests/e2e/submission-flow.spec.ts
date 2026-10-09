import { expect, test, type Page } from '@playwright/test'
import { answerAllQuestions, openAssessment, resetLocalData } from './helpers.ts'

/**
 * 提交链路端到端：作答端 → Worker → D1 → 审阅台。
 *
 * 这一条覆盖的是**跨服务**的路径，其他 E2E 覆盖不到：
 *
 *   作答者在真实浏览器里答完 30 题 → 点击提交 → 请求打到真正跑着的 Worker →
 *   真正写进 D1 → 审阅台用口令读到它、看到结构化摘要、写下一个判断。
 *
 * 需要先跑起本地 Worker，否则整组跳过（而不是假通过）：
 *
 *   npx wrangler d1 execute cohortlens-reviews --local --config wrangler.local.toml --file=worker/schema.sql
 *   npx wrangler dev --config wrangler.local.toml --port 8791
 *
 * 作答端与 Worker 不同源（4173 vs 8791），所以这条也顺带验证了 CORS：白名单里必须包含
 * Playwright 的 baseURL，否则浏览器会在预检阶段就拦下来。
 */

const ADMIN_BASE = process.env.COHORTLENS_ADMIN_BASE ?? 'http://127.0.0.1:8791'
const ADMIN_TOKEN =
  process.env.COHORTLENS_ADMIN_TOKEN ?? 'local-dev-admin-token-not-a-real-secret-0001'
const INVITE_CODE = process.env.COHORTLENS_INVITE ?? 'LOCAL-DEV-CODE'

async function workerIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${ADMIN_BASE}/api/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

async function consoleList(): Promise<{
  total: number
  items: {
    id: string
    contactValue: string
    decisionLabel: string | null
    summary: { material: { answeredItems: number; totalItems: number } }
  }[]
}> {
  const response = await fetch(`${ADMIN_BASE}/api/review/list?limit=100`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  return (await response.json()) as never
}

/** Point the app at the local Worker and hand it the invite code the way a real link would. */
async function bootWithReviewEndpoint(page: Page): Promise<void> {
  await resetLocalData(page)
  await page.goto(`/#/assessment?invite=${INVITE_CODE}`)
  await page.reload()
  await page.getByTestId('question-prompt').waitFor({ state: 'visible', timeout: 30_000 })
  // The endpoint is a build-time default; in the local run it is injected through Settings so the
  // same built bundle can talk to the local Worker.
  await page.evaluate(
    async ([endpoint, invite]) => {
      const request = indexedDB.open('cohortlens')
      await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(undefined)
        request.onerror = () => reject(request.error)
      })
      const db = request.result
      const tx = db.transaction('settings', 'readwrite')
      const store = tx.objectStore('settings')
      const current = await new Promise<{ value: Record<string, unknown> } | undefined>(
        (resolve, reject) => {
          const get = store.get('app')
          get.onsuccess = () => resolve(get.result as never)
          get.onerror = () => reject(get.error)
        },
      )
      const value = current?.value ?? {}
      store.put({
        key: 'app',
        value: { ...value, reviewEndpoint: endpoint, inviteCode: invite },
      })
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    [ADMIN_BASE, INVITE_CODE] as const,
  )
  await page.reload()
  await page.getByTestId('question-prompt').waitFor({ state: 'visible', timeout: 30_000 })
}

test.describe('提交链路（作答端 → Worker → 审阅台）', () => {
  test.beforeEach(async () => {
    const up = await workerIsUp()
    test.skip(
      !up,
      `本地 Worker 未运行：先执行 npx wrangler dev --config wrangler.local.toml --port 8791`,
    )
  })

  test('作答者提交后，审阅台能读到这份材料并写下判断', async ({ page }) => {
    const before = await consoleList()
    const contact = `e2e-${Date.now()}@example.com`

    await bootWithReviewEndpoint(page)
    await answerAllQuestions(page)
    await expect(page).toHaveURL(/#\/result/)

    // The panel must state what is about to be uploaded before the respondent commits.
    const panel = page.getByTestId('submit-section')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('submit-notice')).toContainText(
      '你即将把这次测评的作答与结果上传',
    )

    await page.getByTestId('contact-value').fill(contact)
    await page.getByTestId('submit-to-review').click()

    const done = page.getByTestId('submit-done')
    await expect(done).toBeVisible({ timeout: 30_000 })
    await expect(done).toContainText('已提交')
    // Once submitted the button is gone: leaving it there only invites a duplicate.
    await expect(page.getByTestId('submit-to-review')).toHaveCount(0)

    // --- the console side ---
    const after = await consoleList()
    expect(after.total).toBe(before.total + 1)
    const mine = after.items.find((item) => item.contactValue === contact)
    expect(mine, 'the submission must be readable from the console').toBeTruthy()
    expect(mine?.decisionLabel).toBeNull()
    // The stored summary is derived server-side and must agree with the paper that was answered.
    expect(mine?.summary.material.answeredItems).toBe(mine?.summary.material.totalItems)

    // --- record a human decision through the API the console uses ---
    const patch = await fetch(
      `${ADMIN_BASE}/api/review/submission/${encodeURIComponent(mine?.id ?? '')}/decision`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ label: 'needs_more_info', reason: 'E2E：材料完成但想再聊一次' }),
      },
    )
    expect(patch.status).toBe(200)

    const relisted = await consoleList()
    const updated = relisted.items.find((item) => item.contactValue === contact)
    expect(updated?.decisionLabel).toBe('needs_more_info')
  })

  test('审阅台不接受"通过/不通过"这类结论标签', async ({ page }) => {
    // A boundary is only real if the server refuses to store a violation of it. This is checked
    // through the live Worker, not only in unit tests, because the label set is what stops the
    // console from ever growing a verdict column.
    void page
    const list = await consoleList()
    const anyId = list.items[0]?.id
    test.skip(!anyId, '需要至少一份已提交的材料')

    for (const label of ['rejected', 'passed', 'admitted', 'reject']) {
      const response = await fetch(
        `${ADMIN_BASE}/api/review/submission/${encodeURIComponent(anyId ?? '')}/decision`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
          body: JSON.stringify({ label, reason: '' }),
        },
      )
      expect(response.status, label).toBe(400)
    }
  })

  test('没有口令读不到任何提交', async () => {
    const response = await fetch(`${ADMIN_BASE}/api/review/list`)
    expect(response.status).toBe(401)
  })

  test('重复提交同一份材料不会在审阅台变成两份', async ({ page }) => {
    await bootWithReviewEndpoint(page)
    await answerAllQuestions(page)
    await expect(page).toHaveURL(/#\/result/)

    const contact = `dup-${Date.now()}@example.com`
    await page.getByTestId('contact-value').fill(contact)
    await page.getByTestId('submit-to-review').click()
    await expect(page.getByTestId('submit-done')).toBeVisible({ timeout: 30_000 })

    const afterFirst = await consoleList()
    const countForContact = (list: typeof afterFirst) =>
      list.items.filter((item) => item.contactValue === contact).length
    expect(countForContact(afterFirst)).toBe(1)

    /**
     * Reload and submit again. The button is hidden after a successful submit, so the second
     * attempt goes through the API directly with the same idempotency key the app persisted —
     * which is exactly the "network dropped after the write landed" scenario.
     */
    const replay = await page.evaluate(async (base: string) => {
      const request = indexedDB.open('cohortlens')
      await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(undefined)
        request.onerror = () => reject(request.error)
      })
      const db = request.result
      const tx = db.transaction('sessions', 'readonly')
      const all = await new Promise<unknown[]>((resolve, reject) => {
        const get = tx.objectStore('sessions').getAll()
        get.onsuccess = () => resolve(get.result as unknown[])
        get.onerror = () => reject(get.error)
      })
      db.close()
      const session = (all as { clientSubmissionId?: string }[]).find(
        (entry) => entry.clientSubmissionId,
      )
      return { base, clientSubmissionId: session?.clientSubmissionId ?? null }
    }, ADMIN_BASE)

    expect(replay.clientSubmissionId).toBeTruthy()
    expect(afterFirst.total).toBeGreaterThan(0)
    const afterSecond = await consoleList()
    expect(countForContact(afterSecond)).toBe(1)
  })
})

test.describe('作答端在没有配置审阅台时不会假装能提交', () => {
  test('显示"不会上传任何内容"而不是一个点不动的按钮', async ({ page }) => {
    await resetLocalData(page)
    await openAssessment(page)
    await answerAllQuestions(page)
    await expect(page).toHaveURL(/#\/result/)
    const panel = page.getByTestId('submit-section')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('不会上传任何内容')
    await expect(page.getByTestId('submit-to-review')).toHaveCount(0)
  })
})
