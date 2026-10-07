import { expect, type Page } from '@playwright/test'

/**
 * Shared helpers for the Local E2E suite.
 *
 * Two things this file deliberately does NOT assume:
 *   1. A particular question paper. The 30 items are drawn randomly per session, so every helper
 *      works from the progress counter and from whichever options happen to be on screen.
 *   2. Hash-only navigation. `page.goto('/#/route')` is a *same-document* navigation: the document
 *      is not reloaded, so a React app that boots once will not re-read IndexedDB. Every helper
 *      that needs fresh state performs a real reload instead of relying on the hash change.
 */

export const TOTAL_QUESTIONS = 30

export interface Progress {
  index: number
  total: number
  answered: number
}

/** Read "第 N / 30 题 · 已答 M 题（x%）". */
export async function readProgress(page: Page): Promise<Progress> {
  const text = await page.getByTestId('progress-text').innerText()
  const match = /第\s*(\d+)\s*\/\s*(\d+)\s*题\s*·\s*已答\s*(\d+)\s*题/.exec(text)
  if (!match) throw new Error(`无法解析进度文本：${text}`)
  return { index: Number(match[1]), total: Number(match[2]), answered: Number(match[3]) }
}

/**
 * Clear this origin's local data and arrive at `target` with a freshly booted app.
 *
 * The wipe runs inside the app's own origin because `page.evaluate` on about:blank has an opaque
 * origin and cannot touch IndexedDB.
 *
 * The reload after the wipe is load-bearing, not cosmetic. Deleting a database does not close the
 * connection the running app already holds, so without a reload the app would keep writing through
 * a handle to a deleted database and a later boot could read a mix of old and new rows. Reloading
 * forces a fresh connection, which is also what makes "the browser was closed and reopened" a real
 * scenario rather than a simulated one.
 */
export async function resetLocalData(page: Page, target = '/'): Promise<void> {
  await page.goto('/')
  await page.evaluate(async () => {
    const databases = await indexedDB.databases?.()
    for (const entry of databases ?? []) {
      if (entry.name) indexedDB.deleteDatabase(entry.name)
    }
    sessionStorage.clear()
    localStorage.clear()
  })
  await page.goto(target)
  await page.reload()
  // Wait for the app to finish its boot pass against the empty database before the test proceeds.
  await expect(page.locator('.app-header')).toBeVisible()
}

/** Answer the current question, then wait until the persisted counter actually advances. */
export async function answerCurrentQuestion(page: Page, optionIndex = 0): Promise<number> {
  const before = await readProgress(page)
  const radios = page.locator('.option input[type="radio"]')
  const count = await radios.count()
  if (count === 0) throw new Error('当前页面没有选项')

  const alreadyAnswered = await radios
    .nth(0)
    .isChecked()
    .catch(() => false)
  await radios.nth(Math.min(optionIndex, count - 1)).check({ force: true })

  const expected = alreadyAnswered ? before.answered : before.answered + 1
  await expect
    .poll(async () => (await readProgress(page)).answered, { timeout: 8_000 })
    .toBeGreaterThanOrEqual(expected)
  // The counter updates before the write completes, so also wait for the save indicator. Without
  // this, a test that reloads immediately can race the asynchronous IndexedDB write.
  await waitForAnswerSaved(page)
  return expected
}

/** Wait until the store reports the latest state has reached IndexedDB. */
export async function waitForAnswerSaved(page: Page): Promise<void> {
  await expect
    .poll(() => page.getByTestId('save-state').getAttribute('data-save-state'), { timeout: 8_000 })
    .toBe('saved')
}

/** Wait until the structured result has been written to IndexedDB. */
export async function waitForResultSaved(page: Page): Promise<void> {
  await expect
    .poll(() => page.getByTestId('persistence-state').getAttribute('data-persisted'), {
      timeout: 15_000,
    })
    .toBe('true')
}

/**
 * Hard-navigate and let the app boot from scratch.
 *
 * The reload is what makes "the browser was reopened" real; a hash-only `goto` is a same-document
 * navigation and would leave the in-memory store in place, hiding exactly the behaviour under test.
 */
export async function bootFresh(page: Page, target = '/'): Promise<void> {
  await page.goto(target)
  await page.reload()
  await expect(page.locator('.app-header')).toBeVisible()
}

export interface StoredState {
  currentSessionId: string | null
  sessions: { id: string; status: string; lastIndex?: number; answers: number; resultId?: string }[]
  resultIds: string[]
}

/**
 * Read what is actually in IndexedDB, from inside the page.
 *
 * Diagnostics use this so a persistence failure is reported as "the stored state changed" rather
 * than as a mismatch in rendered text, which is a far harder symptom to interpret.
 */
export async function readStoredState(page: Page): Promise<StoredState> {
  return page.evaluate(async () => {
    const readAll = (store: string) =>
      new Promise<unknown[]>((resolve) => {
        const request = indexedDB.open('cohortlens')
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(store)) {
            resolve([])
            return
          }
          const tx = db.transaction(store, 'readonly')
          const all = tx.objectStore(store).getAll()
          all.onsuccess = () => resolve(all.result)
          all.onerror = () => resolve([])
        }
        request.onerror = () => resolve([])
      })

    const sessions = (await readAll('sessions')) as {
      id: string
      status: string
      lastIndex?: number
      answers: Record<string, string>
      resultId?: string
    }[]
    const results = (await readAll('results')) as { id: string }[]
    const settings = (await readAll('settings')) as {
      key: string
      value: { currentSessionId: string | null }
    }[]

    return {
      currentSessionId: settings[0]?.value.currentSessionId ?? null,
      sessions: sessions.map((session) => ({
        id: session.id,
        status: session.status,
        answers: Object.keys(session.answers ?? {}).length,
        ...(session.lastIndex === undefined ? {} : { lastIndex: session.lastIndex }),
        ...(session.resultId === undefined ? {} : { resultId: session.resultId }),
      })),
      resultIds: results.map((result) => result.id),
    }
  })
}

/**
 * Answer every remaining question on the paper and finish the assessment.
 *
 * The loop drives "next" until the last question, then answers it and uses the finish button. It
 * works whether the caller arrives with zero answers or with twenty.
 */
export async function answerAllQuestions(page: Page): Promise<void> {
  let guard = 0
  for (;;) {
    guard += 1
    if (guard > 80) throw new Error('作答循环没有收敛，疑似页面未按预期推进')

    const progress = await readProgress(page)
    await answerCurrentQuestion(page, guard % 2)

    if (progress.index >= progress.total) break
    await page.getByTestId('next-question').click()
    await page.waitForFunction(
      (expected) => {
        const element = document.querySelector('[data-testid="progress-text"]')
        return Boolean(element && element.textContent?.includes(`第 ${expected}`))
      },
      progress.index + 1,
      { timeout: 10_000 },
    )
  }

  const last = await readProgress(page)
  expect(last.index).toBe(last.total)
  await waitForAnswerSaved(page)
  const finish = page.getByTestId('finish-assessment')
  await expect(finish).toBeEnabled()
  await finish.click()
  await waitForResultSaved(page)
}

/** Configure the offline sample provider and confirm the connection works. */
export async function gotoSettingsAndConfigureMock(page: Page): Promise<void> {
  await page.goto('/#/settings')
  await page.reload()
  await page.getByTestId('provider-select').selectOption('mock')
  await page.getByTestId('api-key-input').fill('local-sample-placeholder')
  await page.getByTestId('test-connection').click()
  await expect(page.getByTestId('connection-status')).toHaveText('连接正常')
}

/** Wait until the service worker has installed and taken control of the page. */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return Boolean(registration?.active)
    },
    undefined,
    { timeout: 30_000 },
  )
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, {
    timeout: 30_000,
  })
}

/**
 * Open the assessment route and wait for a paper to be on screen.
 *
 * `exact: true` matters: the header's 测评 link and the home page's 开始测评 button share the
 * substring "测评", so a non-exact name match resolves to two elements.
 */
export async function openAssessment(page: Page): Promise<void> {
  await page.getByRole('link', { name: '测评', exact: true }).click()
  await expect(page.getByTestId('progress-text')).toBeVisible()
}

/** Open Settings through the header and wait for it to render. */
export async function openSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await expect(page.getByTestId('provider-select')).toBeVisible()
}

/** Open History through the header. */
export async function openHistory(page: Page): Promise<void> {
  await page.getByRole('link', { name: '历史', exact: true }).click()
  await expect(page).toHaveURL(/#\/history/)
}
