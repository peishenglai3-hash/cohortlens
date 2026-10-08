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
  /**
   * A-layer V1.1 renders the theory layer as six section cards instead of a `layer-theory_value`
   * score block, so the assertion names the cards themselves. That is the point of the change: an
   * A-layer result must not be laid out as a score row.
   */
  await expect(page.getByTestId('a-layer-section')).toBeVisible()
  for (const card of [
    'a-card-A0_declared_identity',
    'a-card-A1_theory_structure',
    'a-card-A2_political_economy',
    'a-card-A3_social_political',
    'a-card-A4_practice_orientation',
    'a-card-A5_reflexivity',
  ]) {
    await expect(page.getByTestId(card), card).toBeVisible()
  }
  await expect(page.getByTestId('a-layer-boundaries')).toBeVisible()
  // A0 shows the respondent's own words and no number beside them.
  await expect(page.getByTestId('a-card-A0_declared_identity')).toContainText('系统原样呈现')
  await expect(page.getByTestId('a1-low-sample')).toBeVisible()
  await expect(page.getByTestId('a5-state')).toBeVisible()
  // B and C remain ordinary score sections.
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

  // The first `.evidence` block on the page now belongs to the A5 reflexivity card, which reports
  // "not scored" instead of a signal pair. Both phrasings are checked so the assertion stays true
  // wherever the A-layer section places its evidence.
  const firstEvidence = page.locator('.evidence').first()
  await firstEvidence.locator('summary').click()
  await expect(firstEvidence).toHaveAttribute('open', '')
  await expect(firstEvidence.locator('li').first()).toContainText('你的作答')

  // The B/C score sections must still show a signal pair against their items.
  const scoreEvidence = page.locator('[data-testid="layer-cooperation_behavior"] .evidence').first()
  await scoreEvidence.locator('summary').click()
  await expect(scoreEvidence.locator('li').first()).toContainText('本维度信号')
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
  await expect(page.getByTestId('history-pack-version').first()).toContainText(
    'cohortlens-question-pack-v1.1',
  )
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

/**
 * A-layer V1.1 on a real browser.
 *
 * The unit suite proves the profile *object* is right; this proves the *page* does not turn it back
 * into a scoreboard. The three claims worth an end-to-end test are the ones a user could actually be
 * misled by: A0 showing a number, the A layer being weighed into role fit, or the six parts being
 * summed somewhere on screen.
 */
test('A 层按六张分区卡呈现，且自我认同不出现分数', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  const aSection = page.getByTestId('a-layer-section')
  await expect(aSection).toBeVisible()
  await expect(aSection).toContainText('不参与角色适配')

  // A0: the respondent's own words, quoted. It must contain the chosen option's text and must not
  // present a numeric score anywhere inside the card.
  const a0Card = page.getByTestId('a-card-A0_declared_identity')
  await expect(a0Card.locator('blockquote')).toHaveCount(2)
  await expect(a0Card).toContainText('系统原样呈现')
  await expect(a0Card.locator('.profile-score')).toHaveCount(0)
  await expect(a0Card).not.toContainText('/ 100')

  // A1: a number is allowed, but the low-sample notice must be right next to it.
  const a1Card = page.getByTestId('a-card-A1_theory_structure')
  await expect(a1Card.getByTestId('a1-score')).toBeVisible()
  await expect(a1Card.getByTestId('a1-low-sample')).toContainText('低精度')

  // A2-A4: cards, no scores.
  for (const card of [
    'a-card-A2_political_economy',
    'a-card-A3_social_political',
    'a-card-A4_practice_orientation',
  ]) {
    await expect(page.getByTestId(card), card).toContainText('不折算成分数')
    await expect(page.getByTestId(card).locator('.profile-score'), card).toHaveCount(0)
  }

  // A5: a state label, never a bare number without one.
  const a5State = page.getByTestId('a5-state')
  await expect(a5State).toBeVisible()
  await expect(a5State).toHaveText(/方向相对一致|方向不一致|材料不足/)
})

test('角色适配区不含任何 A 层维度', async ({ page }) => {
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  const roleFit = page.getByTestId('role-fit-section')
  await expect(roleFit).toBeVisible()
  const roleFitText = await roleFit.innerText()
  for (const dimension of [
    'A0_declared_identity',
    'A1_theory_structure',
    'A2_political_economy',
    'A3_social_political',
    'A4_practice_orientation',
    'A5_reflexivity',
  ]) {
    expect(roleFitText, dimension).not.toContain(dimension)
  }
  // And nothing on the page may present a combined A-layer number. The product's own disclaimer
  // legitimately *names* the thing it refuses to produce, so the scan skips negative statements —
  // the same scoping the unit-level boundary checks use.
  const pageText = await page.locator('main').innerText()
  const claimLines = pageText
    .split('\n')
    .filter((line) => !/不生成|不得|不能相加|不输出|不是/.test(line))
  for (const forbidden of ['政治—理论总分', '政治倾向评分', '意识形态评分', '立场指数']) {
    for (const line of claimLines) {
      expect(line, `${forbidden} in: ${line}`).not.toContain(forbidden)
    }
  }
})
