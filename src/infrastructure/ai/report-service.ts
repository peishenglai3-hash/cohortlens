import { maskForbiddenLanguage } from '../../domain/boundaries.ts'
import type { AssessmentResult, QuestionPack } from '../../domain/schemas.ts'
import type { ReportRecord } from '../storage/report-repository.ts'
import type { ReportRepository } from '../storage/report-repository.ts'
import { buildReportPayload } from './report-payload.ts'
import { REPORT_PROMPT_VERSION } from './prompts/report-prompt.ts'
import type { AIProvider, ProviderConfig } from './types.ts'

/**
 * Report generation use case — Engineering Bible §22, §23, §24, §61, §62.
 *
 * The chain is fixed and must not be short-circuited:
 *
 *   Structured Result -> Sanitized Report Payload -> AI Provider -> Narrative Report
 *
 * The model never sees the answer sheet and never produces a score. What it returns is text, and
 * that text is passed through the boundary filter before it is shown or stored, so a model that
 * ignores its instructions still cannot put a forbidden label in front of the user.
 */

export interface GenerateReportInput {
  result: AssessmentResult
  pack: QuestionPack
  config: ProviderConfig
  apiKey: string
  provider: AIProvider
  reports?: ReportRepository
  /** Injected for deterministic tests. */
  now?: () => string
}

export interface GeneratedReport {
  record: ReportRecord
  /** True when the provider was the mock, so the UI can label the report. */
  isMock: boolean
}

export class ReportGenerationError extends Error {
  override readonly name = 'ReportGenerationError'
  /** True when this failure must not disturb the base result (Engineering Bible §62). */
  readonly baseResultIntact: boolean
  override readonly cause?: unknown

  constructor(message: string, baseResultIntact = true, cause?: unknown) {
    super(message)
    this.baseResultIntact = baseResultIntact
    if (cause !== undefined) this.cause = cause
  }
}

export async function generateReport(input: GenerateReportInput): Promise<GeneratedReport> {
  const { result, pack, config, apiKey, provider, reports } = input
  const now = input.now ?? (() => new Date().toISOString())

  if (!apiKey.trim()) {
    throw new ReportGenerationError(
      '还没有配置 API Key。基础测评结果不受影响，可以随时回到设置页填写。',
    )
  }

  const payload = buildReportPayload({ result, pack })

  let generated
  try {
    generated = await provider.generateReport(config, apiKey, payload)
  } catch (error) {
    // §62: an AI failure must never damage the base result. The caller keeps showing the
    // structured result and offers a retry.
    throw new ReportGenerationError('基础测评已经完成。AI 综合报告暂时无法生成。', true, error)
  }

  const masked = maskForbiddenLanguage(generated.content)

  const record: ReportRecord = {
    resultId: result.id,
    createdAt: now(),
    provider: {
      providerId: config.providerId,
      baseURL: config.baseURL,
      model: config.model,
      transport: config.transport,
    },
    versions: {
      prompt: REPORT_PROMPT_VERSION,
      result: {
        questionPack: result.versions.questionPack,
        scoring: result.versions.scoring,
        roleModel: result.versions.roleModel,
      },
    },
    content: masked.text,
    durationMs: generated.durationMs,
    isMock: config.providerId === 'mock',
  }
  if (generated.usage) record.usage = generated.usage
  if (masked.violations.length > 0) record.sanitizedViolations = masked.violations

  if (reports) await reports.put(record)
  return { record, isMock: record.isMock }
}

/** Whether a stored report still matches the current prompt version. */
export function reportPromptIsCurrent(record: ReportRecord): boolean {
  return record.versions.prompt === REPORT_PROMPT_VERSION
}
