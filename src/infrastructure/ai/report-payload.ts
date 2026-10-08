import type {
  ALayerProfile,
  AssessmentResult,
  DimensionResult,
  QuestionPack,
  RoleFitResult,
} from '../../domain/schemas.ts'
import { REPORT_PROMPT_VERSION } from './prompts/report-prompt.ts'
import type {
  ReportPayload,
  ReportPayloadALayer,
  ReportPayloadDimension,
  ReportPayloadRole,
} from './types.ts'

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
 *
 * A-layer V1.1 note: the A layer carries the respondent's own political-theoretical material, so the
 * whitelist is applied there with extra care. A0's self-declared *categories* travel (they are
 * controlled vocabulary and they are the person's own statement); the chosen option text of A2-A5
 * does **not**, because a chosen position is answer-sheet content. See `toPayloadALayer`.
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
    ...(result.aLayerProfile ? { aLayer: toPayloadALayer(result.aLayerProfile) } : {}),
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
      'A 层（aLayer）六个部分不得相加成任何"政治—理论总分"或立场指数。',
      'A0 自我认同只能引用答题者本人自报的类别，不得从 A1 到 A5 的其他维度推断，也不得改写其含义。',
      'A 层结果不得用于角色适配、吸纳或淘汰判断。',
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
    ...(dimension.scoringKind ? { scoringKind: dimension.scoringKind } : {}),
    ...(dimension.scoredItems !== undefined ? { scoredItems: dimension.scoredItems } : {}),
  }
}

/**
 * A-layer whitelist.
 *
 * Keeps only what the model needs to describe the *shape* of the profile: the categories A0
 * declared itself as, the counts and topic labels behind A2-A4, A1's accuracy counts, and A5's
 * state. The respondent's chosen text is dropped on purpose — a chosen position is answer-sheet
 * content, and Engineering Bible §60 keeps the answer sheet out of the payload.
 */
function toPayloadALayer(profile: ALayerProfile): ReportPayloadALayer {
  const measuredItems: ReportPayloadALayer['measuredItems'] = []
  const collector = (
    dimension: string,
    cards: readonly { questionId: string; topic: string }[],
  ): void => {
    if (cards.length === 0) return
    measuredItems.push({
      dimension,
      itemCount: cards.length,
      topics: cards.map((card) => card.topic),
      questionIds: cards.map((card) => card.questionId),
    })
  }
  collector('A2_political_economy', profile.politicalEconomy)
  collector('A3_social_political', profile.socialPolitical)
  collector('A4_practice_orientation', profile.practiceOrientation)

  return {
    displayPolicy: { ...profile.displayPolicy },
    declaredIdentity: profile.declaredIdentity.map((item) => ({
      questionId: item.questionId,
      topic: item.topic,
      selectedCategory: item.selectedCategory,
    })),
    theoryFamiliarity: profile.theoryFamiliarity
      ? {
          correct: profile.theoryFamiliarity.correct,
          answered: profile.theoryFamiliarity.answered,
          normalizedScore: profile.theoryFamiliarity.normalizedScore,
          band: profile.theoryFamiliarity.band,
          lowSample: profile.theoryFamiliarity.lowSample,
        }
      : null,
    measuredItems,
    reflexivity: {
      state: profile.reflexivity.state,
      confidence: round2(profile.reflexivity.confidence),
      evidenceQuestionIds: [...profile.reflexivity.evidenceQuestionIds],
    },
    boundaries: [...profile.boundaries],
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
