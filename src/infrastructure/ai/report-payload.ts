import type {
  AssessmentResult,
  DimensionResult,
  QuestionPack,
  RoleFitResult,
} from '../../domain/schemas.ts'
import { REPORT_PROMPT_VERSION } from './prompts/report-prompt.ts'
import type { ReportPayload, ReportPayloadDimension, ReportPayloadRole } from './types.ts'

/**
 * Report payload construction — Engineering Bible §22 "Sanitization", §60 "LLM 输入最小化".
 *
 * The payload is built by an **explicit whitelist**. Nothing is copied wholesale from the result
 * and then pruned, because a future schema version that adds a field would silently start
 * shipping that field. With a whitelist, a new field is invisible until someone deliberately adds
 * it here.
 *
 * Never included: the respondent's name (the app does not even ask for one), contact details, IP,
 * browser information, the answer sheet, the chosen option text, the session id, the result id,
 * and anything from the report history other than this one result.
 */

export interface BuildPayloadInput {
  result: AssessmentResult
  pack: QuestionPack
}

export function buildReportPayload({ result, pack }: BuildPayloadInput): ReportPayload {
  return {
    promptVersion: REPORT_PROMPT_VERSION,
    versions: {
      questionPack: result.versions.questionPack,
      scoring: result.versions.scoring,
      roleModel: result.versions.roleModel,
      questionBankLanguage: pack.language,
    },
    dimensions: result.dimensions.map(toPayloadDimension),
    roleFits: result.roleFits.map(toPayloadRole),
    strengths: [...result.strengths],
    developmentAreas: [...result.developmentAreas],
    consistency: {
      answerConsistency: round2(result.consistency.answerConsistency),
      extremeRepeatRate: round2(result.consistency.extremeRepeatRate),
      needsFurtherUnderstanding: result.consistency.needsFurtherUnderstanding,
      notes: [...result.consistency.notes],
    },
    limitations: [...result.limitations],
    boundaries: [
      '不得输出录用、淘汰、通过、不通过等结论。',
      '不得判断政治可靠、政治忠诚或意识形态纯度。',
      '不得输出值得信任/不值得信任/危险人物/撒谎概率等决定性标签。',
      '不得产生任何总分或排名。',
      '不得仅凭单个答案下结论；材料不足时必须明说。',
    ],
  }
}

function toPayloadDimension(dimension: DimensionResult): ReportPayloadDimension {
  return {
    id: dimension.id,
    label: dimension.label,
    layer: dimension.layer,
    score: dimension.normalizedScore,
    band: dimension.band,
    items: dimension.answeredItems,
    confidence: round2(dimension.confidence),
    // Question ids only. The chosen option text is intentionally withheld (§60).
    evidenceQuestionIds: [...dimension.evidenceQuestionIds],
  }
}

function toPayloadRole(role: RoleFitResult): ReportPayloadRole {
  return {
    roleId: role.roleId,
    name: role.name,
    fitScore: role.fitScore,
    coverage: round2(role.coverage),
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Guard used by tests and by the Settings screen: assert that a built payload contains no secret
 * and no answer text. Returns the list of violations (empty means clean).
 */
export function auditReportPayload(
  payload: ReportPayload,
  forbiddenSnippets: readonly string[],
): string[] {
  const serialised = JSON.stringify(payload)
  return forbiddenSnippets.filter((snippet) => snippet.length > 0 && serialised.includes(snippet))
}
