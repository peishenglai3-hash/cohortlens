import { expect, test } from '@playwright/test'
import {
  answerCurrentQuestion,
  answerAllQuestions,
  bootFresh,
  openAssessment,
  openHistory,
  readProgress,
  readStoredState,
  resetLocalData,
  TOTAL_QUESTIONS,
  waitForResultSaved,
} from './helpers.ts'

/**
 * Local end-to-end: the main user flow required by the Local MVP brief §24.
 *
 *   Open app -> Start -> Answer -> Refresh (progress persists) -> Finish -> Result -> History
 *
 * Nothing here needs a network or an API key: this is the local core, which must work offline.
 */

test.beforeEach(async ({ page }) => {
  await resetLocalData(page)
})

test('首页可以打开，并且明确说明数据只存在本机', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'CohortLens', exact: true })).toBeVisible()
  await expect(page.getByText('数据使用说明')).toBeVisible()
  await expect(page.getByText('这份结果的边界')).toBeVisible()
  await expect(page.getByTestId('start-assessment')).toBeVisible()
})

test('完整主流程：抽 30 题 → 逐题作答 → 中途刷新不丢进度 → 完成 → 看结果', async ({ page }) => {
  await page.getByTestId('start-assessment').click()

  // The paper is drawn locally: 30 questions, no network involved.
  await expect(page.getByTestId('progress-text')).toContainText(`/ ${TOTAL_QUESTIONS} 题`)
  const start = await readProgress(page)
  expect(start.total).toBe(TOTAL_QUESTIONS)
  expect(start.index).toBe(1)

  // Answer a few, then reload: the answered count must survive (Engineering Bible §54).
  for (let i = 0; i < 4; i += 1) {
    await answerCurrentQuestion(page, i % 2)
    await page.getByTestId('next-question').click()
  }
  const beforeReload = await readProgress(page)
  expect(beforeReload.answered).toBe(4)

  const promptBefore = await page.getByTestId('question-prompt').innerText()
  await page.reload()

  const afterReload = await readProgress(page)
  expect(afterReload.answered).toBe(4)
  expect(afterReload.total).toBe(TOTAL_QUESTIONS)
  // The same paper, not a freshly drawn one: the question on screen is unchanged.
  await expect(page.getByTestId('question-prompt')).toHaveText(promptBefore)

  await answerAllQuestions(page)

  // Result page: a structured result, not a verdict.
  await expect(page).toHaveURL(/#\/result/)
  await expect(page.getByTestId('layer-theory_value')).toBeVisible()
  await expect(page.getByTestId('layer-cooperation_behavior')).toBeVisible()
  await expect(page.getByTestId('layer-skill_role')).toBeVisible()
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
  await expect(page.getByTestId('consistency-section')).toBeVisible()
  await expect(page.getByTestId('limitations')).toBeVisible()
  await expect(page.getByText('系统不输出单一总分')).toBeVisible()

  // Forbidden framing must not appear in the result content. The check is scoped to the sections
  // that make claims about a person: the product's own disclaimers legitimately *name* the labels
  // it refuses to output ("不输出录用、淘汰建议"), so a whole-page substring scan would flag the
  // boundary statement itself.
  const claimSections = page.locator(
    '[data-testid="strengths"], [data-testid="development-areas"], [data-testid="role-fit-section"]',
  )
  const claimText = await claimSections.allInnerTexts()
  for (const forbidden of ['录取', '淘汰', 'PASS', 'FAIL', '政治可靠', '总分排名', '值得信任']) {
    for (const text of claimText) expect(text).not.toContain(forbidden)
  }
})

test('直接打开测评页会在没有进行中测评时自动开始一次', async ({ page }) => {
  await openAssessment(page)
  expect((await readProgress(page)).total).toBe(TOTAL_QUESTIONS)
  await expect(page.getByTestId('question-prompt')).toBeVisible()
})

test('证据可以展开：每个维度能回看到题目与自己的作答', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  const firstEvidence = page.locator('.evidence').first()
  await firstEvidence.locator('summary').click()
  await expect(firstEvidence).toHaveAttribute('open', '')
  await expect(firstEvidence.locator('li').first()).toContainText('你的作答')
  await expect(firstEvidence.locator('li').first()).toContainText('本维度信号')
})

test('刷新结果页后仍然能看到同一份结果（结果已落盘）', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)
  await waitForResultSaved(page)
  const summary = await page.getByTestId('strengths').innerText()

  const before = await readStoredState(page)
  await page.reload()
  await expect(page).toHaveURL(/#\/result/)
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
  const after = await readStoredState(page)
  // Diagnostic assertions first: if the stored state changed across a reload, that is the bug, and
  // it should be named as such instead of surfacing as a mismatch in the rendered text.
  expect(after.sessions.map((session) => session.id)).toEqual(
    before.sessions.map((session) => session.id),
  )
  expect(after.currentSessionId).toBe(before.currentSessionId)
  expect(after.sessions[0]?.resultId).toBe(before.sessions[0]?.resultId)
  expect(after.resultIds).toEqual(before.resultIds)
  // Compare the rendered items, normalised. `innerText` separates list items with newlines while
  // `toHaveText` compares the element's whole text content, so compare the item texts directly.
  const itemsAfter = await page.getByTestId('strengths').locator('li').allInnerTexts()
  expect(itemsAfter.join(' | ')).toBe(summary.split('\n').join(' | '))
})

test('历史记录包含刚完成的结果，并能重新打开', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  await openHistory(page)
  await expect(page.getByTestId('history-status').first()).toHaveText('已完成')
  await expect(page.getByTestId('history-pack-version').first()).toContainText('cohortlens-cn-v1')
  await expect(page.getByTestId('history-delete').first()).toBeVisible()

  await page.getByTestId('history-open').first().click()
  await expect(page).toHaveURL(/#\/result/)
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
})

test('未完成的测评可以继续，首页给出继续与重开两个选择', async ({ page }) => {
  await openAssessment(page)
  await answerCurrentQuestion(page, 0)
  await page.getByTestId('next-question').click()
  expect((await readProgress(page)).answered).toBe(1)

  // A real reload is what makes "the user came back later" a real scenario.
  await bootFresh(page, '/')
  await expect(page.getByTestId('resume-card')).toBeVisible()
  await expect(page.getByTestId('resume-continue')).toContainText('还剩 29 题')

  // "重新开始" is guarded by a confirmation dialog; dismissing it must change nothing.
  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByTestId('resume-restart').click()
  await bootFresh(page, '/')
  await expect(page.getByTestId('resume-card')).toBeVisible()
  await expect(page.getByTestId('resume-continue')).toContainText('还剩 29 题')

  // Accepting the dialog starts a fresh paper with zero answers.
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByTestId('resume-restart').click()
  await openAssessment(page)
  expect((await readProgress(page)).answered).toBe(0)
})

test('测评页的「放弃并重开」需要确认', async ({ page }) => {
  await openAssessment(page)
  await answerCurrentQuestion(page, 0)
  expect((await readProgress(page)).answered).toBe(1)

  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByTestId('abandon-and-restart').click()
  expect((await readProgress(page)).answered).toBe(1)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByTestId('abandon-and-restart').click()
  await expect.poll(async () => (await readProgress(page)).answered).toBe(0)
})

test('删除历史记录需要确认', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await openHistory(page)
  const countBefore = await page.locator('.history-item').count()
  expect(countBefore).toBeGreaterThan(0)

  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByTestId('history-delete').first().click()
  await expect(page.locator('.history-item')).toHaveCount(countBefore)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByTestId('history-delete').first().click()
  await expect(page.locator('.history-item')).toHaveCount(countBefore - 1)
})

test('JSON 导出会真的产生一个不含 API Key 的文件', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-json').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^cohortlens-.*\.json$/)

  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text) as Record<string, unknown>

  expect(parsed.format).toBe('cohortlens-export')
  expect(parsed.session).toBeTruthy()
  expect(parsed.result).toBeTruthy()
  expect(parsed.versions).toBeTruthy()
  // Never a credential, in any shape.
  expect(text).not.toContain('apiKey')
  expect(text).not.toContain('sk-')
  expect(text).not.toContain('Bearer')

  await expect(page.getByTestId('export-message')).toContainText('已导出')
})
