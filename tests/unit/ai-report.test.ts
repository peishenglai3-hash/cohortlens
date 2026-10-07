import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import {
  buildReportPayload,
  auditReportPayload,
} from '../../src/infrastructure/ai/report-payload.ts'
import {
  buildReportPrompt,
  REPORT_PROMPT_VERSION,
} from '../../src/infrastructure/ai/prompts/report-prompt.ts'
import {
  generateReport,
  ReportGenerationError,
  reportPromptIsCurrent,
} from '../../src/infrastructure/ai/report-service.ts'
import {
  createProvider,
  applyPreset,
  findPreset,
  PROVIDER_PRESETS,
  isMockPreset,
} from '../../src/infrastructure/ai/factory.ts'
import {
  classifyError,
  OpenAICompatibleProvider,
  STATUS_LABELS,
} from '../../src/infrastructure/ai/adapters/openai-compatible.ts'
import { BrowserDirectTransport } from '../../src/infrastructure/ai/transports/browser-direct.ts'
import { MockTransport } from '../../src/infrastructure/ai/transports/mock.ts'
import { createDatabaseHandle } from '../../src/infrastructure/storage/db.ts'
import { createRepositories } from '../../src/infrastructure/storage/index.ts'
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfig } from '../../src/config/provider-config.ts'
import type { ReportPayload } from '../../src/infrastructure/ai/types.ts'

/**
 * AI report chain tests.
 *
 * The chain that must not change (Local MVP brief §18):
 *   Answers -> Local Engine -> Structured Result -> Sanitized Payload -> Provider -> Report
 *
 * Every test here runs against the MockTransport, so no real key and no network are needed, while
 * the adapter, the prompt builder, the boundary filter and the repository are all really exercised.
 */

const bundle = loadContentBundle()
const { pack } = bundle

function completedRun(seed: string) {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `sess_${seed}`,
    createdAt: '2026-10-07T12:00:00.000Z',
  })
  const questions = paperQuestions(bundle, created.session)
  const answers = simulateAnswers(questions, seed)
  return completeAssessment(
    bundle,
    { ...created.session, answers },
    {
      generatedAt: '2026-10-07T12:00:00.000Z',
    },
  )
}

const mockConfig: ProviderConfig = {
  ...DEFAULT_PROVIDER_CONFIG,
  providerId: 'mock',
  baseURL: 'https://mock.local/v1',
  model: 'mock-report-model',
}

describe('report payload (engineering bible §60)', () => {
  const { result } = completedRun('payload-1')
  const payload = buildReportPayload({ result, pack })

  it('carries the identifiers the report needs', () => {
    expect(payload.promptVersion).toBe(REPORT_PROMPT_VERSION)
    expect(payload.versions.questionPack).toBe(result.versions.questionPack)
    expect(payload.versions.questionBankLanguage).toBe(pack.language)
    expect(payload.dimensions).toHaveLength(result.dimensions.length)
    expect(payload.roleFits).toHaveLength(result.roleFits.length)
  })

  it('never carries the answer sheet, the chosen options, or any identifier of the person', () => {
    const serialised = JSON.stringify(payload)
    // No chosen option id may appear.
    for (const evidence of result.evidence.slice(0, 8)) {
      expect(serialised).not.toContain(evidence.optionId)
    }
    // No session or result id may appear.
    expect(serialised).not.toContain(result.sessionId)
    expect(serialised).not.toContain(result.id)
    // No credential-shaped string, and none of the answer-sheet containers.
    for (const forbidden of ['apiKey', 'api_key', 'sk-', 'answers', '"prompt"', '"optionId"']) {
      expect(serialised).not.toContain(forbidden)
    }
    // Identity fields have no place at the top level of the payload at all.
    const topLevelKeys = Object.keys(payload)
    expect(topLevelKeys).not.toContain('name')
    expect(topLevelKeys).not.toContain('sessionId')
    expect(topLevelKeys).not.toContain('resultId')
  })

  it('keeps the evidence as question ids only', () => {
    for (const dimension of payload.dimensions) {
      for (const id of dimension.evidenceQuestionIds) {
        expect(id).toMatch(/^[ABC]\d{3}$/)
      }
    }
  })

  it('carries the boundary instructions the model must respect', () => {
    expect(payload.boundaries.length).toBeGreaterThanOrEqual(4)
    expect(payload.boundaries.join(' ')).toContain('不得输出录用')
    expect(payload.boundaries.join(' ')).toContain('不得判断政治可靠')
  })

  it('passes its own audit when checked against real answer text', () => {
    const answerTexts = pack.questions
      .slice(0, 10)
      .flatMap((question) => question.options.map((option) => option.text))
    expect(auditReportPayload(payload, [result.sessionId, result.id, ...answerTexts])).toEqual([])
  })
})

describe('report prompt', () => {
  it('mandates the eight sections the brief requires', () => {
    const { result } = completedRun('prompt-1')
    const payload = buildReportPayload({ result, pack })
    const prompt = buildReportPrompt(payload)
    for (const section of [
      '## 整体概况',
      '## 主要优势',
      '## 合作方式',
      '## 任务风格',
      '## 适合承担的工作类型',
      '## 可能的磨合点',
      '## 建议进一步人工了解的问题',
      '## 测评局限性',
    ]) {
      expect(prompt.user).toContain(section)
    }
    expect(prompt.system).toContain('你不重新打分')
    expect(prompt.system).toContain('不判断这个人是')
  })

  it('embeds the payload so the model cannot need the raw answers', () => {
    const { result } = completedRun('prompt-2')
    const payload = buildReportPayload({ result, pack })
    const prompt = buildReportPrompt(payload)
    expect(prompt.user).toContain('"promptVersion"')
    expect(prompt.version).toBe(REPORT_PROMPT_VERSION)
  })
})

describe('provider presets', () => {
  it('loads from content and validates', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(3)
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toContain('mock')
  })

  it('fills base URL, transport and model-list strategy on selection', () => {
    const deepseek = findPreset('deepseek')
    expect(deepseek).toBeDefined()
    const applied = applyPreset(deepseek!, DEFAULT_PROVIDER_CONFIG)
    expect(applied.config.baseURL).toBe(deepseek!.baseURL)
    expect(applied.config.transport).toBe('browser-direct')
    expect(applied.config.supportsModelList).toBe(true)
    expect(applied.config.model).toBe('deepseek-chat')
    expect(applied.config.isCustom).toBe(false)
  })

  it('marks the custom preset so Advanced mode opens', () => {
    const custom = findPreset('custom')
    const applied = applyPreset(custom!, DEFAULT_PROVIDER_CONFIG)
    expect(applied.config.isCustom).toBe(true)
    expect(applied.config.baseURL).toBe('')
  })

  it('routes the mock preset to the offline provider', () => {
    expect(isMockPreset('mock')).toBe(true)
    expect(isMockPreset('deepseek')).toBe(false)
  })
})

describe('mock provider drives the real report chain', () => {
  it('generates a report through the adapter, prompt and transport', async () => {
    const { result } = completedRun('report-1')
    const provider = createProvider(mockConfig)
    const payload = buildReportPayload({ result, pack })
    const generated = await provider.generateReport(mockConfig, 'placeholder-key', payload)
    expect(generated.content).toContain('## 整体概况')
    expect(generated.content).toContain('## 测评局限性')
    expect(generated.content).toContain('本地示例 Provider')
    expect(generated.usage?.totalTokens).toBeGreaterThan(0)
    expect(generated.model).toBe('mock-report-model')
  })

  it('reports a connection status for every failure mode the brief lists', async () => {
    const SECRET = 'sk-VERY-SECRET-VALUE-1234567890'
    const cases: [string, string][] = [
      ['invalid_api_key', 'invalid_api_key'],
      ['model_not_found', 'model_not_found'],
      ['cors_restriction', 'cors_restriction'],
      ['network_error', 'cors_restriction'],
      ['timeout', 'timeout'],
      ['quota_error', 'quota_error'],
      ['provider_error', 'provider_error'],
    ]
    for (const [failWith, expected] of cases) {
      const transport = new MockTransport({ failWith: failWith as never })
      const provider = new OpenAICompatibleProvider(transport)
      const diagnosis = await provider.testConnection(mockConfig, SECRET)
      expect(diagnosis.status, `failWith=${failWith}`).toBe(expected)
      expect(diagnosis.message.length).toBeGreaterThan(0)
      // The concrete secret value must never reach anything the UI renders or logs.
      expect(JSON.stringify(diagnosis), `failWith=${failWith}`).not.toContain(SECRET)
      expect(STATUS_LABELS[expected as keyof typeof STATUS_LABELS]).toBeDefined()
    }
  })

  it('succeeds against a healthy mock and lists models', async () => {
    const provider = createProvider(mockConfig)
    const result = await provider.testConnection(mockConfig, 'placeholder')
    expect(result.status).toBe('ok')
    const models = await provider.listModels!(mockConfig, 'placeholder')
    expect(models.map((model) => model.id)).toContain('mock-report-model')
  })

  it('detects an unknown model before generating', async () => {
    const transport = new MockTransport({ models: ['only-this-one'] })
    const provider = new OpenAICompatibleProvider(transport)
    const result = await provider.testConnection({ ...mockConfig, model: 'not-there' }, 'key')
    expect(result.status).toBe('model_not_found')
  })
})

describe('report service', () => {
  it('persists the report and marks it as mock', async () => {
    const handle = await createDatabaseHandle('cohortlens-report-test-1')
    const repos = createRepositories(handle)
    const { result } = completedRun('service-1')
    const provider = createProvider(mockConfig)
    const generated = await generateReport({
      result,
      pack,
      config: mockConfig,
      apiKey: 'placeholder',
      provider,
      reports: repos.reports,
      now: () => '2026-10-07T12:00:00.000Z',
    })
    expect(generated.isMock).toBe(true)
    const stored = await repos.reports.getByResult(result.id)
    expect(stored?.content.length).toBeGreaterThan(50)
    expect(stored?.versions.prompt).toBe(REPORT_PROMPT_VERSION)
    expect(reportPromptIsCurrent(stored!)).toBe(true)
    // The stored record must not contain the key.
    expect(JSON.stringify(stored)).not.toContain('placeholder')
    handle.close()
  })

  it('masks forbidden language if a model emits it, and records what was masked', async () => {
    const handle = await createDatabaseHandle('cohortlens-report-test-2')
    const repos = createRepositories(handle)
    const { result } = completedRun('service-2')
    // A transport that returns a report abusing the boundary vocabulary.
    const rogue = {
      kind: 'browser-direct' as const,
      available: true,
      request: async () => ({
        status: 200,
        json: {
          choices: [
            {
              message: {
                content:
                  '## 整体概况\n这个人不值得信任，是危险人物，撒谎概率很高，政治可靠。\n## 主要优势\n- 无',
              },
            },
          ],
        },
        text: '',
      }),
    }
    const provider = new OpenAICompatibleProvider(rogue)
    const generated = await generateReport({
      result,
      pack,
      config: mockConfig,
      apiKey: 'placeholder',
      provider,
      reports: repos.reports,
    })
    expect(generated.record.content).not.toContain('不值得信任')
    expect(generated.record.content).not.toContain('危险人物')
    expect(generated.record.content).not.toContain('撒谎概率')
    expect(generated.record.content).not.toContain('政治可靠')
    expect(generated.record.content).toContain('[已按产品边界屏蔽]')
    expect(generated.record.sanitizedViolations?.length).toBeGreaterThanOrEqual(4)
    handle.close()
  })

  it('records the masked phrases for diagnostics but never renders them', async () => {
    const handle = await createDatabaseHandle('cohortlens-report-test-3')
    const repos = createRepositories(handle)
    const { result } = completedRun('service-5')
    const rogue = {
      kind: 'browser-direct' as const,
      available: true,
      request: async () => ({
        status: 200,
        json: { choices: [{ message: { content: '## 整体概况\n这个人不值得信任。' } }] },
        text: '',
      }),
    }
    const generated = await generateReport({
      result,
      pack,
      config: mockConfig,
      apiKey: 'placeholder',
      provider: new OpenAICompatibleProvider(rogue),
      reports: repos.reports,
    })
    // The diagnostic record keeps the phrase that was found, for auditing.
    expect(generated.record.sanitizedViolations).toContain('不值得信任')
    // The displayed content is masked, and the shorter fragment must not survive either.
    expect(generated.record.content).not.toContain('值得信任')
    expect(generated.record.content).toContain('[已按产品边界屏蔽]')
    handle.close()
  })

  it('never damages the base result when generation fails (§62)', async () => {
    const { result } = completedRun('service-3')
    const provider = createProvider(mockConfig, { mock: { failWith: 'provider_error' } })
    const before = JSON.stringify(result)
    await expect(
      generateReport({ result, pack, config: mockConfig, apiKey: 'placeholder', provider }),
    ).rejects.toThrow(ReportGenerationError)
    expect(JSON.stringify(result)).toBe(before)
    try {
      await generateReport({ result, pack, config: mockConfig, apiKey: 'placeholder', provider })
    } catch (error) {
      expect((error as ReportGenerationError).message).toContain('基础测评已经完成')
      expect((error as ReportGenerationError).baseResultIntact).toBe(true)
    }
  })

  it('refuses to run with an empty key instead of sending a request', async () => {
    const { result } = completedRun('service-4')
    const provider = createProvider(mockConfig)
    await expect(
      generateReport({ result, pack, config: mockConfig, apiKey: '   ', provider }),
    ).rejects.toThrow(/还没有配置 API Key/)
  })
})

describe('configuration validation before any request', () => {
  it('rejects an empty base URL, an empty key and a malformed URL', async () => {
    const provider = new OpenAICompatibleProvider(new BrowserDirectTransport())
    const noUrl = await provider.testConnection({ ...mockConfig, baseURL: '' }, 'k')
    expect(noUrl.status).toBe('unknown_error')
    const noKey = await provider.testConnection(mockConfig, '')
    expect(noKey.status).toBe('invalid_api_key')
    const badUrl = await provider.testConnection({ ...mockConfig, baseURL: 'not a url' }, 'k')
    expect(badUrl.status).toBe('unknown_error')
    expect(badUrl.suggestion).toContain('http')
  })

  it('maps an aborted request to timeout', () => {
    const diagnosis = classifyError(new DOMException('aborted', 'AbortError'), mockConfig)
    expect(diagnosis.status).toBe('timeout')
  })

  it('maps an opaque TypeError to the cors explanation with the honest remedy', () => {
    const diagnosis = classifyError(new TypeError('Failed to fetch'), mockConfig)
    expect(diagnosis.status).toBe('cors_restriction')
    expect(diagnosis.suggestion).toContain('LocalBridge')
    expect(diagnosis.suggestion).toContain('不要')
  })

  it('never leaks a key into the technical detail', () => {
    const diagnosis = classifyError(new TypeError('Failed to fetch'), mockConfig)
    expect(JSON.stringify(diagnosis)).not.toContain('Bearer')
    expect(JSON.stringify(diagnosis)).not.toContain('sk-')
  })
})

describe('mock transport is not presented as a real model', () => {
  it('labels its output as a local sample', async () => {
    const { result } = completedRun('mock-label')
    const provider = createProvider(mockConfig)
    const payload: ReportPayload = buildReportPayload({ result, pack })
    const generated = await provider.generateReport(mockConfig, 'k', payload)
    expect(generated.content).toContain('不联网、不调用任何模型')
  })
})
