import { expect, test } from '@playwright/test'
import {
  answerCurrentQuestion,
  answerAllQuestions,
  openAssessment,
  openHistory,
  readProgress,
  resetLocalData,
  waitForServiceWorkerControl,
} from './helpers.ts'

/**
 * Offline boundary and PWA — Local MVP brief §21/§22/§23.
 *
 * The offline case is produced with `context.setOffline(true)`, which is closer to reality than
 * stubbing a fetch: the service worker serves the precached shell and the local engine keeps
 * working, because it never needed the network in the first place.
 *
 * What must still work offline: open the cached app, start or continue an assessment, finish local
 * scoring, browse history, export existing data. What may be disabled: AI report generation, which
 * must say so instead of erroring.
 */

test('断网后仍然可以打开应用、继续测评、完成本地评分并查看历史', async ({ page, context }) => {
  await resetLocalData(page)
  await waitForServiceWorkerControl(page)

  // Complete one assessment online.
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  // Cut the network and reload into the cached shell.
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
  await expect(page.getByTestId('limitations')).toBeVisible()

  // History is local and still reachable.
  await openHistory(page)
  await expect(page.getByTestId('history-status').first()).toBeVisible()

  // Export works offline: it is a Blob, not a server round-trip.
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('history-export').first().click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.json$/)

  // Continue into a local assessment, still offline. The finished assessment is still the
  // "current session", so "continue" would open its result — this step needs a fresh paper, and
  // starting one requires the confirmation the UI asks for. Booting fresh makes the home page read
  // a settled database instead of an in-flight write.
  /**
   * Clearing local data and rebooting is the only reliable way to reach an "empty" state for this
   * step: the app latches its current session in memory, so neither the start link (which the home
   * page hides once a session exists) nor the assessment route's auto-start fires while a finished
   * assessment is still current. Both of those are correct product behaviour; the test simply has
   * to ask for a clean slate instead of fighting them.
   */
  await resetLocalData(page, '/')
  await openAssessment(page)
  await expect(page.getByTestId('question-prompt')).toBeVisible()
  await expect(page.getByTestId('progress-text')).toContainText('题')

  // Answering a question offline must persist, not merely render.
  await answerCurrentQuestion(page, 0)
  expect((await readProgress(page)).answered).toBe(1)

  await context.setOffline(false)
})

test('离线时 AI 报告按钮给出提示而不是白屏或报错', async ({ page }) => {
  await resetLocalData(page, '/#/settings')
  await page.getByTestId('provider-select').selectOption('mock')
  await page.getByTestId('api-key-input').fill('placeholder')

  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  // The UI exposes an explicit offline toggle so this boundary can be verified without tearing
  // down the browser's network stack in the middle of a test.
  await page.getByTestId('toggle-offline').click()
  await expect(page.getByTestId('network-state')).toHaveText('离线模式')
  await expect(page.getByTestId('offline-note')).toContainText('联网后可生成 AI 综合报告')
  await expect(page.getByTestId('generate-report')).toBeDisabled()

  // Everything local stays available.
  await expect(page.getByTestId('print-result')).toBeEnabled()
  await expect(page.getByTestId('export-json')).toBeEnabled()
  await expect(page.getByTestId('role-fit-section')).toBeVisible()

  await page.getByTestId('toggle-offline').click()
  await expect(page.getByTestId('generate-report')).toBeEnabled()
})

test('PWA：manifest 可访问，图标存在，service worker 注册并支持离线打开', async ({
  page,
  request,
}) => {
  await page.goto('/')

  const manifestResponse = await request.get('/manifest.webmanifest')
  expect(manifestResponse.status()).toBe(200)
  const manifest = (await manifestResponse.json()) as {
    name: string
    display: string
    icons: { sizes: string; purpose?: string }[]
  }
  expect(manifest.name).toBe('CohortLens')
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true)
  expect(manifest.icons.some((icon) => icon.sizes === '512x512')).toBe(true)
  expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)

  // Two manifest links exist by design: index.html declares one so the manifest is discoverable
  // before the plugin's HTML transform runs, and vite-plugin-pwa adds its own. Neither is wrong;
  // the assertion records the known shape so a third one would show up as a change.
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(2)
  const rels = await page
    .locator('link[rel="manifest"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
  for (const href of rels) expect(href).toContain('manifest.webmanifest')
  expect((await request.get('/icons/pwa-192x192.png')).status()).toBe(200)
  expect((await request.get('/icons/apple-touch-icon.png')).status()).toBe(200)

  const swResponse = await request.get('/sw.js')
  expect(swResponse.status()).toBe(200)
  expect(await swResponse.text()).toContain('precache')

  await waitForServiceWorkerControl(page)

  // Offline capability is only real if the shell is actually precached: reload with the network
  // down and the document must still render.
  await page.context().setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'CohortLens', exact: true })).toBeVisible()
  await page.context().setOffline(false)
})

test('打印样式：导航与按钮在打印时不出现，报告正文保留', async ({ page }) => {
  await resetLocalData(page)
  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  await page.emulateMedia({ media: 'print' })
  // Chrome's print emulation applies the print stylesheet to the live DOM.
  await expect(page.locator('.app-header')).toBeHidden()
  await expect(page.locator('.app-footer')).toBeHidden()
  await expect(page.getByTestId('export-json')).toBeHidden()
  await expect(page.getByTestId('print-result')).toBeHidden()
  // The report body itself must remain.
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
  await expect(page.getByTestId('limitations')).toBeVisible()

  await page.emulateMedia({ media: 'screen' })
  await expect(page.locator('.app-header')).toBeVisible()
})
