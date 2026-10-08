import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { answerAllQuestions, readProgress, TOTAL_QUESTIONS } from './helpers.ts'

/**
 * 单文件交付版验收（甲方交付物）。
 *
 * 这个 spec 与其他 E2E 的区别在于**它不启动任何服务器**。它把 `dist-delivery/index.html` 用
 * `file://` 打开，也就是甲方双击文件时的真实情形。三件事必须成立：
 *
 *   1. 应用能起来（不是白屏）—— `file://` 没有 origin，任何"必须有 origin 才能跑"的假设都会在这里暴露；
 *   2. 主流程能在不联网、无服务器的条件下走完（抽题 → 作答 → 结果 → 历史）；
 *   3. 页面**不引用任何外部文件**。这一条是"单文件"的定义，也最容易在加了一个 public 资源后悄悄失效。
 *
 * 需要先跑 `npm run build:delivery`。文件不存在时用例会被 skip，而不是给出一个假通过。
 */

const DELIVERY_HTML = fileURLToPath(new URL('../../dist-delivery/index.html', import.meta.url))
const DELIVERY_URL = `file:///${DELIVERY_HTML.replace(/\\/g, '/')}`

test.describe('单文件交付版（file:// 直开）', () => {
  test.skip(() => !existsSync(DELIVERY_HTML), '尚未构建交付版：请先运行 npm run build:delivery')

  test('双击打开即可用：首页渲染，且没有任何外部请求', async ({ page }) => {
    const externalRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('about:')) return
      externalRequests.push(url)
    })

    const failedRequests: string[] = []
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`)
    })

    await page.goto(DELIVERY_URL)
    await expect(page.getByRole('heading', { name: 'CohortLens', exact: true })).toBeVisible()
    await expect(page.getByTestId('start-assessment')).toBeVisible()
    await expect(page.getByText('数据使用说明')).toBeVisible()

    // A single-file artefact must not fetch anything. A failed fetch is the usual symptom of a
    // leftover `<link rel="manifest">` or an icon that did not get inlined.
    expect(failedRequests, `请求失败：\n${failedRequests.join('\n')}`).toEqual([])
    expect(externalRequests, `外部请求：\n${externalRequests.join('\n')}`).toEqual([])
  })

  test('单文件版能走完本地主流程：抽题 → 作答 → 结果 → 历史', async ({ page }) => {
    await page.goto(DELIVERY_URL)
    await page.getByTestId('start-assessment').click()
    await expect(page.getByTestId('question-prompt')).toBeVisible()
    expect((await readProgress(page)).total).toBe(TOTAL_QUESTIONS)

    await answerAllQuestions(page)
    await expect(page).toHaveURL(/#\/result/)
    await expect(page.getByTestId('a-layer-section')).toBeVisible()
    await expect(page.getByTestId('role-fit-section')).toBeVisible()

    // History must be readable in the same file:// origin.
    await page.getByRole('link', { name: '历史', exact: true }).click()
    await expect(page.getByTestId('history-status').first()).toHaveText('已完成')
    await expect(page.getByTestId('history-pack-version').first()).toContainText(
      'cohortlens-question-pack-v1.1',
    )
  })

  test('单文件版不需要 Service Worker，也不该尝试注册', async ({ page }) => {
    const warnings: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text())
    })
    await page.goto(DELIVERY_URL)
    await expect(page.getByTestId('start-assessment')).toBeVisible()

    /**
     * `navigator.serviceWorker.getRegistration()` itself throws a SecurityError on `file://`
     * ("The URL protocol of the current origin ('null') is not supported"), so asking the browser
     * for a registration is not a usable probe here. That error message is in fact the evidence:
     * the API is unreachable on this origin, which is exactly why the build must not call it.
     *
     * Two observable checks replace the probe:
     *   - the page produced no Service-Worker-related console noise, and
     *   - the shipped HTML contains no service-worker registration code at all.
     */
    expect(warnings.join('\n')).not.toContain('Service Worker')
    const html = readFileSync(DELIVERY_HTML, 'utf8')
    expect(html).not.toContain('serviceWorker')
    expect(html).not.toContain('registerSW')
    expect(html).not.toContain('workbox')
    expect(html).not.toContain('sw.js')
  })
})
