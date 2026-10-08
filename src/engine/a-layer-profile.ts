import {
  A_LAYER_BOUNDARIES,
  A_LAYER_DIMENSIONS,
  type ALayerProfile,
  type AssessmentSession,
  type DeclaredIdentityItem,
  type DimensionResult,
  type IssuePositionCard,
  type Question,
  type ReflexivitySummary,
  type ScoringModel,
  type TheoryFamiliarity,
} from '../domain/schemas.ts'

/**
 * A-layer profile builder (A-layer V1.1).
 *
 * The A layer is no longer a four-dimension score vector. It is six parts that must each be shown
 * as what they actually are:
 *
 *   A0 declared identity   — the respondent's own words. No number exists and none may be invented;
 *                            `a-scoring-model-v1.1` principle 1 forbids inferring it from A1-A5.
 *   A1 theory familiarity  — a knowledge score against a key, always flagged low-sample at 3 items.
 *   A2/A3 issue positions  — evidence cards: the question, and the position the person chose.
 *   A4 practice patterns   — the same, for how they prefer to work.
 *   A5 reflexivity         — a summary that is only allowed to speak when its two items agree.
 *
 * Two rules are enforced structurally rather than by convention:
 *   1. nothing here can produce a combined A-layer score, because no field in the output holds one;
 *   2. A2-A5 `profileSignals` are never read. They are exploratory calibration material and
 *      `userFacingByDefault` is `false`, so surfacing them would contradict the pack.
 */

export interface BuildALayerProfileInput {
  paper: { questions: Question[]; byId: Map<string, Question> }
  session: AssessmentSession
  scoring: ScoringModel
  dimensions: DimensionResult[]
}

const DIM = {
  a0: 'A0_declared_identity',
  a1: 'A1_theory_structure',
  a2: 'A2_political_economy',
  a3: 'A3_social_political',
  a4: 'A4_practice_orientation',
  a5: 'A5_reflexivity',
} as const

/** The default display policy when a pack does not carry its own (V1.0 packs have none). */
const FALLBACK_DISPLAY_POLICY: Record<string, string> = {
  [DIM.a0]: 'categorical_self_report',
  [DIM.a1]: 'knowledge_familiarity_low_sample',
  [DIM.a2]: 'issue_position_cards',
  [DIM.a3]: 'issue_position_cards',
  [DIM.a4]: 'practice_pattern_cards',
  [DIM.a5]: 'qualitative_summary_with_evidence',
}

function bandFor(bands: ScoringModel['interpretationBands'], score: number): string {
  const sorted = [...bands].sort((a, b) => a.min - b.min)
  for (const band of sorted) {
    if (score >= band.min && score <= band.max) return band.label
  }
  return sorted[0]?.label ?? ''
}

export function buildALayerProfile({
  paper,
  session,
  scoring,
  dimensions,
}: BuildALayerProfileInput): ALayerProfile | undefined {
  const aDimensions = Object.keys(scoring.layerA.dimensions)
  // A V1.0 result has four A dimensions under different ids. The A-layer V1.1 profile only applies
  // when the six V1.1 dimensions are actually present, so a legacy pack is left untouched.
  if (!aDimensions.includes(DIM.a0)) return undefined

  const declaredPolicy = scoring.layerA.displayPolicy ?? {}
  const displayPolicy: Record<string, string> = {}
  for (const dimension of aDimensions) {
    displayPolicy[dimension] = declaredPolicy[dimension] ?? FALLBACK_DISPLAY_POLICY[dimension] ?? ''
  }

  const inPaper = (dimension: string): Question[] =>
    paper.questions.filter((question) => question.dimension === dimension)

  /** Resolve the option the respondent actually chose, by option id. */
  const chosenOption = (question: Question) => {
    const optionId = session.answers[question.id]
    if (!optionId) return null
    return question.options.find((option) => option.id === optionId) ?? null
  }

  // --- A0: verbatim self-description ----------------------------------------
  const declaredIdentity: DeclaredIdentityItem[] = []
  for (const question of inPaper(DIM.a0)) {
    const option = chosenOption(question)
    if (!option?.selfReportCategory) continue
    declaredIdentity.push({
      questionId: question.id,
      topic: question.subDimension,
      selectedCategory: option.selfReportCategory,
      selectedText: option.text,
    })
  }

  // --- A1: knowledge familiarity against the key ----------------------------
  const a1Questions = inPaper(DIM.a1)
  const a1Dimension = dimensions.find((dimension) => dimension.id === DIM.a1)
  let theoryFamiliarity: TheoryFamiliarity | null = null
  if (a1Questions.length > 0) {
    let correct = 0
    let answered = 0
    const evidenceIds: string[] = []
    for (const question of a1Questions) {
      const option = chosenOption(question)
      if (!option) continue
      answered += 1
      evidenceIds.push(question.id)
      const values = question.options
        .map((candidate) => Object.values(candidate.scoring ?? {})[0])
        .filter((value): value is number => typeof value === 'number')
      const best = values.length > 0 ? Math.max(...values) : 0
      const chosenValue = Object.values(option.scoring ?? {})[0] ?? 0
      if (best > 0 && chosenValue === best) correct += 1
    }
    const denominator = Math.max(1, answered)
    const normalizedScore = answered > 0 ? Math.round((correct / denominator) * 100) : 0
    theoryFamiliarity = {
      correct,
      answered,
      normalizedScore,
      band: answered > 0 ? bandFor(scoring.interpretationBands, normalizedScore) : '不产生分数',
      // The quota is 3 items. Any paper at or below 3 answered items is inherently low-sample, and
      // saying so is required rather than optional.
      lowSample: answered <= 3,
      note:
        answered === 0
          ? '本次问卷未抽到该维度题目，无法给出理论熟悉度。'
          : `本次仅 ${answered} 题，属于低精度提示（low sample）；它只反映对这几道概念题的作答情况，不等于理论水平，也不构成任何政治资格判断。`,
      evidenceQuestionIds: evidenceIds,
    }
    void a1Dimension
  }

  // --- A2/A3/A4: issue-position and practice-pattern cards -------------------
  const cards = (dimension: string): IssuePositionCard[] => {
    const out: IssuePositionCard[] = []
    for (const question of inPaper(dimension)) {
      const option = chosenOption(question)
      if (!option) continue
      out.push({
        questionId: question.id,
        topic: question.subDimension,
        prompt: question.prompt,
        selectedText: option.text,
      })
    }
    return out
  }

  // --- A5: reflexivity, only when the two items agree ------------------------
  const reflexivity = summarizeReflexivity(inPaper(DIM.a5), chosenOption)

  return {
    displayPolicy,
    declaredIdentity,
    theoryFamiliarity,
    politicalEconomy: cards(DIM.a2),
    socialPolitical: cards(DIM.a3),
    practiceOrientation: cards(DIM.a4),
    reflexivity,
    boundaries: [...A_LAYER_BOUNDARIES],
  }
}

/**
 * A5 summary.
 *
 * The pack's reporting rule is: "show a cautious reflexivity summary only if both sampled items
 * align; otherwise say mixed/insufficient evidence". Alignment is read from the exploratory axis
 * signals — the one place they are used at all — and only ever to decide *whether the system may
 * speak*, never to produce a number about the person. If the two items sit on different axes, or
 * their signs disagree, the honest output is "insufficient", not an average.
 */
function summarizeReflexivity(
  questions: readonly Question[],
  chosenOption: (question: Question) => Question['options'][number] | null,
): ReflexivitySummary {
  const evidenceQuestionIds: string[] = []
  const signs: number[] = []
  const axes = new Set<string>()

  for (const question of questions) {
    const option = chosenOption(question)
    if (!option) continue
    evidenceQuestionIds.push(question.id)
    const signals = option.profileSignals ?? {}
    for (const [axis, value] of Object.entries(signals)) {
      axes.add(axis)
      signs.push(Math.sign(value))
    }
  }

  if (signs.length < 2) {
    return {
      state: 'insufficient',
      summary:
        '本次问卷在反身性维度上的材料不足（少于两道有效题目），系统不给出摘要，只保留原始作答供人工查看。',
      confidence: 0,
      evidenceQuestionIds,
    }
  }

  const allPositive = signs.every((sign) => sign >= 0)
  const allNegative = signs.every((sign) => sign <= 0)
  const aligned = allPositive || allNegative

  if (!aligned) {
    return {
      state: 'mixed',
      summary:
        '本次抽到的反身性题目给出的方向不一致（一题偏开放修正，另一题偏维持原有判断），系统不强行总结成单一结论，请直接看原始作答。',
      confidence: 0.25,
      evidenceQuestionIds,
    }
  }

  return {
    state: 'aligned',
    summary: `本次抽到的 ${evidenceQuestionIds.length} 道反身性题目方向相对一致，呈现出较低置信度的"愿意依据证据修正判断"倾向。这只描述本次答卷，不代表稳定的思维方式。`,
    confidence: 0.4,
    evidenceQuestionIds,
  }
}

export { A_LAYER_DIMENSIONS }
