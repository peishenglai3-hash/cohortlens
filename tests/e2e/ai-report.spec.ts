import { expect, test } from '@playwright/test'
import {
  answerAllQuestions,
  gotoSettingsAndConfigureMock,
  openAssessment,
  openHistory,
  resetLocalData,
  waitForServiceWorkerControl,
} from './helpers.ts'

/**
 * Local E2E for the AI report chain, driven by the built-in mock provider.
 *
 * Local MVP brief §25: automated tests must not require a real secret. The mock speaks the same
 * OpenAI-compatible shapes as the real adapter, so this exercises the real chain:
 *   Structured Result -> Sanitized Payload -> Provider -> Narrative Report -> Persistence
 *
 * Choosing a preset also proves the "填 Key 就能用" path: base URL, transport and model are filled
 * in for the user, leaving exactly two fields to touch.
 */

test.beforeEach(async ({ page }) => {
  await resetLocalData(page, '/#/settings')
})

test('设置页默认只暴露两项：服务商与 API Key；base URL 等只在高级设置里', async ({ page }) => {
  await expect(page.getByTestId('advanced-settings')).toHaveCount(0)
  await expect(page.getByTestId('provider-select')).toBeVisible()
  await expect(page.getByTestId('api-key-input')).toBeVisible()
  await expect(page.getByTestId('base-url-input')).toHaveCount(0)
  await expect(page.getByTestId('temperature-input')).toHaveCount(0)
  await expect(page.getByTestId('timeout-input')).toHaveCount(0)
})

test('选择预设会自动填好 baseURL、传输方式与模型', async ({ page }) => {
  await page.getByTestId('provider-select').selectOption('deepseek')
  await expect(page.getByTestId('preset-note')).toContainText('OpenAI 兼容')
  // The preset filled the model in, so the user supplies only the key.
  await expect(page.getByTestId('model-input')).toHaveValue('deepseek-chat')

  await page.getByRole('button', { name: '展开高级设置' }).click()
  await expect(page.getByTestId('advanced-settings')).toBeVisible()
  await expect(page.getByTestId('base-url-input')).toHaveValue('https://api.deepseek.com/v1')
  await expect(page.getByTestId('transport-select')).toHaveValue('browser-direct')
})

test('记住此设备是显式 opt-in，并有提示文案', async ({ page }) => {
  await expect(page.getByTestId('remember-note')).toContainText('仅在自己的设备上使用')
  await expect(page.getByTestId('remember-note')).toContainText('默认不保存')

  await page.getByTestId('api-key-input').fill('device-memory-placeholder')
  await page.getByTestId('remember-device').check()
  await expect(page.getByTestId('settings-message')).toContainText('已保存在这台设备的浏览器数据中')

  await page.getByTestId('remember-device').uncheck()
  await expect(page.getByTestId('settings-message')).toContainText('已取消')
})

test('测试连接会给出人类可读结论，技术详情默认折叠且不含 Key', async ({ page }) => {
  await gotoSettingsAndConfigureMock(page)
  const banner = page.getByTestId('connection-result')
  await expect(banner).toContainText('连接成功')
  await banner.locator('summary').click()
  const technical = await banner.locator('pre').innerText()
  expect(technical).not.toContain('local-sample-placeholder')
  expect(technical).toContain('API Key 不会出现在这里')
})

test('Mock Provider 跑通 AI 报告并落盘', async ({ page }) => {
  await gotoSettingsAndConfigureMock(page)

  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  await page.getByTestId('generate-report').click()
  await expect(page.getByTestId('report-body')).toBeVisible({ timeout: 30_000 })
  const reportText = await page.getByTestId('report-body').innerText()

  for (const section of [
    '整体概况',
    '主要优势',
    '合作方式',
    '任务风格',
    '适合承担的工作类型',
    '可能的磨合点',
    '建议进一步人工了解的问题',
    '测评局限性',
  ]) {
    expect(reportText).toContain(section)
  }
  expect(reportText).toContain('本地示例')

  for (const forbidden of ['值得信任', '不值得信任', '危险人物', '撒谎概率', '政治可靠']) {
    expect(reportText).not.toContain(forbidden)
  }

  // The report survives a reload because it was written to IndexedDB.
  await page.reload()
  await expect(page.getByTestId('report-body')).toBeVisible()
  await expect(page.getByTestId('report-body')).toContainText('整体概况')

  // And History marks the record as having a report.
  await openHistory(page)
  await expect(page.getByTestId('history-has-report').first()).toBeVisible()
})

test('AI 报告失败不会影响基础结果，且历史记录仍可打开', async ({ page }) => {
  // A realistic misconfiguration: provider selected, no model chosen. The adapter refuses before
  // sending anything, which is the path a user hits when they skip step three.
  await page.getByTestId('provider-select').selectOption('mock')
  await page.getByTestId('api-key-input').fill('placeholder')
  await page.getByTestId('model-input').fill('')

  await openAssessment(page)
  await answerAllQuestions(page)
  await expect(page).toHaveURL(/#\/result/)

  await page.getByTestId('generate-report').click()
  await expect(page.getByTestId('report-error')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('report-error')).toContainText('基础测评已经完成')

  // The base result stays fully usable.
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
  await expect(page.getByTestId('limitations')).toBeVisible()
  await expect(page.getByTestId('export-json')).toBeEnabled()
  await expect(page.getByTestId('print-result')).toBeEnabled()

  await openHistory(page)
  await page.getByTestId('history-open').first().click()
  await expect(page.getByTestId('role-fit-section')).toBeVisible()
  await expect(page.getByTestId('dimension-responsibility')).toBeVisible()
})

test('两种传输方式在界面上可区分，LocalBridge 明确标注当前不可用', async ({ page }) => {
  await page.getByRole('button', { name: '展开高级设置' }).click()
  const transport = page.getByTestId('transport-select')
  await expect(transport.locator('option[value="local-bridge"]')).toContainText('当前不可用')
})

test('Service Worker 安装后，应用外壳由缓存提供', async ({ page }) => {
  await waitForServiceWorkerControl(page)
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
  expect(controlled).toBe(true)
})
