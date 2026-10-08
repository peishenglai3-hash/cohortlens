import {
  LAYERS,
  type AssessmentResult,
  type AssessmentSession,
  type DimensionResult,
  type EvidenceReference,
  type Layer,
  type Question,
  type QuestionPack,
  type RoleModel,
  type ScoringModel,
} from '../domain/schemas.ts'
import { analyseConsistency, consistencyPenalty, type ConsistencyState } from './consistency.ts'
import { buildALayerProfile } from './a-layer-profile.ts'
import { computeRoleFits } from './role-fit.ts'
import type { SamplerStageReport } from './sampler.ts'

/**
 * Stage-one local scoring engine — Engineering Bible §14/§15/§16.
 *
 *   Answers -> Option Signals -> Dimension Aggregation -> Normalization
 *           -> Consistency Analysis -> Role Fit -> Structured Result
 *
 * No LLM takes part in any step of this file (§14 "不调用 LLM", §4 Deterministic Core).
 *
 * Two properties are load-bearing and are tested directly:
 *   - the same (questionIds, answers, versions) always yields the identical result;
 *   - nothing produces a single overall total score (§16). The output is a profile vector.
 */

export interface ScoreInput {
  pack: QuestionPack
  scoring: ScoringModel
  roleModel: RoleModel
  session: AssessmentSession
  /** ISO timestamp. Passed in rather than read from the clock so results stay reproducible. */
  generatedAt: string
  /** Layer-A short dimensions of previous sessions, for the sampler's rotation report. */
  previousSessions?: readonly { seed: string; shortDimension: string | null }[]
  /** Sampler stage reports produced when this paper was drawn. */
  samplerStages?: readonly SamplerStageReport[]
}

export interface IndexedPaper {
  questions: Question[]
  byId: Map<string, Question>
  missingQuestionIds: string[]
}

export class ScoringError extends Error {
  override readonly name = 'ScoringError'
}

function layerKey(layer: Layer): 'layerA' | 'layerB' | 'layerC' {
  if (layer === 'theory_value') return 'layerA'
  if (layer === 'cooperation_behavior') return 'layerB'
  return 'layerC'
}

/** Resolve the paper: the session's stored `questionIds`, in stored order. */
export function indexPaper(pack: QuestionPack, session: AssessmentSession): IndexedPaper {
  const byId = new Map(pack.questions.map((question) => [question.id, question]))
  const questions: Question[] = []
  const missingQuestionIds: string[] = []
  for (const questionId of session.questionIds) {
    const question = byId.get(questionId)
    if (!question) {
      // Engineering Bible §12: a stored paper must not drift when the bank is upgraded. A
      // missing id is surfaced loudly instead of being silently skipped.
      missingQuestionIds.push(questionId)
      continue
    }
    questions.push(question)
  }
  return { questions, byId, missingQuestionIds }
}

/**
 * Expected item count per dimension, used as the denominator of confidence.
 * Engineering Bible §14 declares `confidence.base = answered_items / expected_items` but never
 * defines `expected_items`; ADR-008 records the definition used here:
 *   1. the pack's declared per-assessment figure when it has one (layer A subQuota);
 *   2. the pack's declared exactly-per-dimension figure (layer C);
 *   3. the layer's minimum-per-dimension figure (layer B, which is under-sampled by design);
 *   4. otherwise an even split of the layer quota across the layer's dimensions.
 * Consequence under bank V1.0: layer B and C dimensions legitimately reach confidence 0.5 and
 * 1.0 respectively against these denominators, and both are flagged as small-sample.
 */
export function buildExpectedItems(pack: QuestionPack, scoring: ScoringModel): Map<string, number> {
  const expected = new Map<string, number>()
  const subQuota = pack.assessmentPolicy.subQuota

  for (const layer of LAYERS) {
    const dimensions = Object.keys(scoring[layerKey(layer)].dimensions)
    const layerQuota = pack.assessmentPolicy.quota[layer] ?? 0
    const evenSplit = dimensions.length > 0 ? layerQuota / dimensions.length : 0
    for (const dimension of dimensions) {
      let value = evenSplit
      if (layer === 'theory_value') {
        value = subQuota?.theory_value[dimension] ?? evenSplit
      } else if (layer === 'skill_role') {
        value = subQuota?.skill_role.exactlyPerDimension ?? evenSplit
      } else if (layer === 'cooperation_behavior') {
        value = subQuota?.cooperation_behavior.minimumPerDimension ?? evenSplit
      }
      expected.set(dimension, Math.max(1, Math.round(value)))
    }
  }
  return expected
}

function bandLabel(bands: ScoringModel['interpretationBands'], score: number): string {
  const sorted = [...bands].sort((a, b) => a.min - b.min)
  for (const band of sorted) {
    if (score >= band.min && score <= band.max) return band.label
  }
  const first = sorted[0]
  return first ? first.label : ''
}

interface RawDimension {
  layer: Layer
  label: string
  rawScore: number
  maxPossible: number
  answeredItems: number
  /** Answered items that actually carried a numeric signal. */
  scoredItems: number
  /** Accumulated per-question kinds, used to derive the dimension's `scoringKind`. */
  kinds: Set<DimensionScoringKind>
  evidenceQuestionIds: string[]
  /** Distinct normalised values reachable from the answers that were actually given. */
  reachableNormalised: Set<number>
}

export type DimensionScoringKind = 'numeric' | 'knowledge' | 'categorical' | 'descriptive'

/**
 * Which kind of value a question contributes.
 *
 * The distinction is not cosmetic: it decides whether a dimension may show a number at all. A0 is
 * `categorical` because it is a self-description, and `a-scoring-model-v1.1` principle 1 forbids
 * deriving it from anything else. A2-A5 are `descriptive`: they carry position signals that are
 * calibration material, not correctness, and the pack explicitly asks for evidence cards instead of
 * pseudo-precise axis scores.
 */
export function scoringKindFor(question: Question): DimensionScoringKind {
  if (question.layer !== 'theory_value') return 'numeric'
  if (question.scoringMode === 'knowledge_accuracy') return 'knowledge'
  // A0 is the one A dimension whose whole purpose is direct self-report.
  if (question.dimension === 'A0_declared_identity') return 'categorical'
  return 'descriptive'
}

/** True when an option contributes a numeric score. An empty `scoring` map deliberately does not. */
function numericSignal(option: Question['options'][number]): number | null {
  const values = Object.values(option.scoring ?? {})
  if (values.length === 0) return null
  return values[0] ?? null
}

/**
 * Collapse the kinds accumulated for a dimension.
 *
 * A dimension whose items disagree is described by the most restrictive kind present, because the
 * restrictive one is the one that constrains what may be displayed: a single non-numeric item is
 * enough to make a numeric label wrong for the whole dimension.
 */
function resolveDimensionKind(kinds: ReadonlySet<DimensionScoringKind>): DimensionScoringKind {
  if (kinds.size === 0) return 'numeric'
  if (kinds.size === 1) return [...kinds][0] ?? 'numeric'
  if (kinds.has('categorical')) return 'categorical'
  if (kinds.has('descriptive')) return 'descriptive'
  if (kinds.has('knowledge')) return 'knowledge'
  return 'numeric'
}

/**
 * Reachable normalised values for a set of answered items: every combination of the options
 * those items offer. Used to state honestly how coarse a dimension's measurement is.
 */
function reachableNormalisedValues(
  questions: readonly Question[],
  maxPerQuestion: number,
): Set<number> {
  let sums = new Set<number>([0])
  for (const question of questions) {
    const values = [
      ...new Set(question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)),
    ]
    const next = new Set<number>()
    for (const sum of sums) {
      for (const value of values) next.add(sum + value)
    }
    sums = next
  }
  const denominator = Math.max(1, maxPerQuestion * questions.length)
  return new Set([...sums].map((sum) => Math.round((sum / denominator) * 100)))
}

/**
 * Turn a pack's measurement notice into limitations text.
 *
 * V1.0 wrote `{validatedPsychometricInstrument: false, notes: [...]}`; V1.1 writes a plain array of
 * statements. Both are surfaced verbatim rather than paraphrased, because the statements are the
 * author's own description of what the instrument is not.
 */
function measurementNoticeLimitations(pack: QuestionPack): string[] {
  const notice = pack.measurementNotice
  if (!notice) return []
  if (Array.isArray(notice)) return [...notice]
  const out = [...notice.notes]
  if (!notice.validatedPsychometricInstrument) {
    out.unshift('本题库自述不是经过标准化常模验证的心理测量工具，结果只用于辅助讨论。')
  }
  return out
}

export function scoreAssessment({
  pack,
  scoring,
  roleModel,
  session,
  generatedAt,
  samplerStages = [],
}: ScoreInput): AssessmentResult {
  const maxSignal = scoring.scale.maxPerQuestion
  const paper = indexPaper(pack, session)

  if (paper.missingQuestionIds.length > 0) {
    throw new ScoringError(
      `本次问卷引用了题库 ${pack.id}@${pack.version} 中不存在的题目：${paper.missingQuestionIds.join(', ')}。历史测评必须靠保存的 selectedQuestionIds 复现，不能被静默跳过。`,
    )
  }
  if (session.scoringVersion !== scoring.version) {
    throw new ScoringError(
      `会话记录 scoringVersion=${session.scoringVersion}，当前评分模型 version=${scoring.version}，不允许用不同版本的规则重算历史结果。`,
    )
  }
  if (session.questionPackVersion !== pack.version) {
    throw new ScoringError(
      `会话记录 questionPackVersion=${session.questionPackVersion}，当前题库 version=${pack.version}，不允许跨版本重算。`,
    )
  }

  const expectedItems = buildExpectedItems(pack, scoring)

  // --- 1. option signals + dimension aggregation -----------------------------
  const raw = new Map<string, RawDimension>()
  const evidence: EvidenceReference[] = []
  const signalByQuestion = new Map<string, number | null>()
  const maxSignalByQuestion = new Map<string, number>()
  const chosenOptionByQuestion = new Map<string, string | null>()
  const answeredByDimension = new Map<string, Question[]>()

  for (const question of paper.questions) {
    const dimensionKey = layerKey(question.layer)
    const declaredLabel = scoring[dimensionKey].dimensions[question.dimension]
    if (declaredLabel === undefined) {
      throw new ScoringError(
        `题目 ${question.id} 的维度 ${question.dimension} 未在评分模型 ${scoring.id}@${scoring.version} 中声明。`,
      )
    }
    const kind = scoringKindFor(question)
    // The achievable maximum comes only from options that actually carry a signal. For a
    // descriptive or categorical question every option is signal-free, so the question has no
    // numeric maximum at all — which is the point, not an oversight.
    const signalValues = question.options
      .map((option) => numericSignal(option))
      .filter((value): value is number => value !== null)
    const questionMax = signalValues.length > 0 ? Math.max(...signalValues) : 0
    maxSignalByQuestion.set(question.id, questionMax)

    const chosen = session.answers[question.id]
    const option = chosen
      ? question.options.find((candidate) => candidate.id === chosen)
      : undefined

    const entry =
      raw.get(question.dimension) ??
      ({
        layer: question.layer,
        label: declaredLabel,
        rawScore: 0,
        maxPossible: 0,
        answeredItems: 0,
        scoredItems: 0,
        kinds: new Set<DimensionScoringKind>(),
        evidenceQuestionIds: [],
        reachableNormalised: new Set<number>(),
      } satisfies RawDimension)
    entry.kinds.add(kind)

    if (option === undefined) {
      chosenOptionByQuestion.set(question.id, null)
      signalByQuestion.set(question.id, null)
    } else {
      const signal = numericSignal(option)
      if (signal !== null) {
        entry.rawScore += signal
        entry.maxPossible += questionMax
        entry.scoredItems += 1
      }
      entry.answeredItems += 1
      entry.evidenceQuestionIds.push(question.id)
      signalByQuestion.set(question.id, signal)
      chosenOptionByQuestion.set(question.id, option.id)
      const list = answeredByDimension.get(question.dimension) ?? []
      list.push(question)
      answeredByDimension.set(question.dimension, list)
      evidence.push({
        questionId: question.id,
        dimension: question.dimension,
        optionId: option.id,
        // `signal: 0` with `maxSignal: 0` is how a non-numeric item reports itself: there is no
        // correctness to record, and reporting a made-up 0 would read as "answered badly".
        signal: signal ?? 0,
        maxSignal: questionMax,
      })
    }

    raw.set(question.dimension, entry)
  }

  for (const [dimension, entry] of raw) {
    if (entry.scoredItems === 0) continue
    entry.reachableNormalised = reachableNormalisedValues(
      (answeredByDimension.get(dimension) ?? []).filter((question) =>
        question.options.some((option) => numericSignal(option) !== null),
      ),
      maxSignal,
    )
  }

  // --- 2. consistency analysis ----------------------------------------------
  const consistencyState: ConsistencyState = {
    signalByQuestion,
    maxSignalByQuestion,
    paperQuestionIds: new Set(paper.questions.map((question) => question.id)),
  }
  const consistencyDraft = analyseConsistency(scoring, consistencyState)
  const penalty = consistencyPenalty(consistencyDraft)

  // Which dimensions a penalised pairing concerns, so the penalty lands on the right rows.
  const penalisedDimensions = new Set<string>()
  const groupById = new Map(scoring.confidence.consistencyGroups.map((group) => [group.id, group]))
  for (const finding of consistencyDraft.findings) {
    if (finding.confidencePenalty <= 0) continue
    const group = groupById.get(finding.groupId)
    if (!group) continue
    for (const questionId of group.questions) {
      const question = paper.byId.get(questionId)
      if (question) penalisedDimensions.add(question.dimension)
    }
  }

  // --- 3. dimension rows ----------------------------------------------------
  const dimensions: DimensionResult[] = []
  for (const layer of LAYERS) {
    for (const dimension of Object.keys(scoring[layerKey(layer)].dimensions)) {
      const entry = raw.get(dimension)
      if (!entry) continue

      const kind = resolveDimensionKind(entry.kinds)
      const numeric = entry.scoredItems > 0 && entry.maxPossible > 0
      /**
       * A dimension with no numeric items has no score. It is reported as 0/0 with kind
       * `categorical` or `descriptive` so every consumer can see that the number does not exist —
       * rather than a normalised 0, which a reader would inevitably take as "scored badly".
       */
      const normalised = numeric ? Math.round((entry.rawScore / entry.maxPossible) * 100) : 0
      const expected = expectedItems.get(dimension) ?? 1
      const coverage = Math.min(1, entry.answeredItems / Math.max(1, expected))
      const dimensionPenalty = penalisedDimensions.has(dimension) ? Math.min(0.45, penalty) : 0
      const confidence = Math.max(0, Math.min(1, coverage * (1 - dimensionPenalty)))

      const warnings: string[] = []
      if (!numeric) {
        warnings.push(
          kind === 'categorical'
            ? '该维度是答题者直接自报的自我描述，本身不产生分数；系统只原样呈现其选择，不从其他维度推断。'
            : '该维度在本次问卷中只提供描述性证据，不产生数值分数；系统只呈现原始选择。',
        )
      }
      if (numeric && entry.scoredItems <= 2) {
        const reachable = [...entry.reachableNormalised].sort((a, b) => a - b)
        warnings.push(
          `本次问卷只抽到 ${entry.scoredItems} 道该维度题目，归一化分数只能取 ${reachable
            .map((value) => String(value))
            .join(' / ')} 这几个值，粒度过粗，不能当作细粒度测量。`,
        )
      }
      if (numeric && entry.maxPossible < entry.scoredItems * maxSignal) {
        warnings.push(
          `该维度有题目的选项分值上限低于 ${maxSignal}，分母按实际可达上限 ${entry.maxPossible} 计算。`,
        )
      }
      if (kind === 'knowledge' && entry.scoredItems > 0 && entry.scoredItems <= 3) {
        warnings.push(
          `该维度单次仅 ${entry.scoredItems} 题，属于低精度提示（low sample），不能当作理论水平评定。`,
        )
      }
      if (dimensionPenalty > 0) {
        warnings.push(
          `该维度涉及的一致性配对存在方向差异，置信度已下调 ${(dimensionPenalty * 100).toFixed(0)}%。`,
        )
      }

      dimensions.push({
        id: dimension,
        layer,
        label: entry.label,
        rawScore: entry.rawScore,
        normalizedScore: normalised,
        confidence,
        answeredItems: entry.answeredItems,
        scoredItems: entry.scoredItems,
        scoringKind: kind,
        expectedItems: expected,
        maxPossible: entry.maxPossible,
        band: numeric ? bandLabel(scoring.interpretationBands, normalised) : '不产生分数',
        evidenceQuestionIds: entry.evidenceQuestionIds,
        warnings,
      })
    }
  }

  dimensions.sort((a, b) => {
    const layerDelta = LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer)
    if (layerDelta !== 0) return layerDelta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // --- 4. role fit (layer A is structurally excluded) ------------------------
  const roleFits = computeRoleFits(roleModel, dimensions, scoring)

  // --- 5. strengths / development areas ------------------------------------
  /**
   * Only dimensions that actually produced a number can be ranked, and the wording depends on what
   * kind of number it is.
   *
   * A0 is excluded by construction (it has no numeric items) — listing a self-described identity as
   * a strength or a weakness would turn a self-description into a judgement about the person.
   * A2-A5 are excluded for the same reason: they are evidence cards, and `a-scoring-model-v1.1`
   * asks for the raw positions, not a summary score.
   *
   * A1 stays, because it is a genuine knowledge score, but it is phrased as low-sample familiarity
   * rather than as a verdict about the person's theory.
   */
  const ranked = dimensions.filter(
    (dimension) => dimension.answeredItems > 0 && (dimension.scoredItems ?? 0) > 0,
  )

  const phraseFor = (dimension: DimensionResult, direction: 'high' | 'low'): string => {
    if (dimension.scoringKind === 'knowledge') {
      const base = `${dimension.label}（${dimension.id}）：本次问卷 ${dimension.answeredItems} 题中答对 ${dimension.rawScore} 题，折合 ${dimension.normalizedScore} 分。`
      return direction === 'high'
        ? `${base}这是低精度提示（low sample），只说明这几道概念题的作答情况，不代表理论水平。`
        : `${base}这是低精度提示（low sample），题量太少，不足以说明理论水平，也不构成任何政治资格判断。`
    }
    return direction === 'high'
      ? `${dimension.label}（${dimension.id}）：本次问卷中 ${dimension.normalizedScore} 分，落在「${dimension.band}」区间，证据题 ${dimension.evidenceQuestionIds.join('、')}。`
      : `${dimension.label}（${dimension.id}）：本次问卷中 ${dimension.normalizedScore} 分。分数偏低可能来自题目选择或作答方式，需要结合原始回答与本人进一步确认，不构成能力判断。`
  }

  const strengths = ranked
    .slice()
    .sort((a, b) => b.normalizedScore - a.normalizedScore || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((dimension) => phraseFor(dimension, 'high'))

  const developmentAreas = ranked
    .slice()
    .sort((a, b) => a.normalizedScore - b.normalizedScore || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((dimension) => phraseFor(dimension, 'low'))

  // --- 6. limitations -------------------------------------------------------
  const limitations: string[] = [
    '分数只在当前题库体系内部有意义，不是人口常模，也不是百分位。',
    '系统不生成单一总分（Engineering Bible §16）。各维度不能相加成一个"综合素质"分数。',
    '理论层（A 层）结果不得解释为政治立场、政治忠诚、政治可靠性或意识形态纯度，也不参与角色适配。',
    'A 层的六个部分不能相加成一个"政治—理论总分"；自我认同（A0）只能由答题者本人直接自报，系统不从其他回答推断。',
    '合作与技能层（B / C 层）是自陈材料，受社会赞许倾向影响，必须结合原始回答人工复核。',
    '回答一致性只描述答卷内部的方向差异，不代表是否"真实"，更不能推出任何关于人的结论。',
    'A2–A5 在 V1.1 以议题立场与实践模式的原始卡片为主，不生成伪精确的多轴分数。',
  ]
  const smallSample = dimensions.filter(
    (dimension) => (dimension.scoredItems ?? 0) > 0 && dimension.answeredItems <= 2,
  )
  if (smallSample.length > 0) {
    limitations.push(
      `本次问卷中有 ${smallSample.length} 个维度只由 1-2 道题支撑（${smallSample
        .map((dimension) => `${dimension.label}=${dimension.answeredItems}题`)
        .join('、')}），这些维度的分数粒度极粗。`,
    )
  }
  const aKnowledge = dimensions.find((dimension) => dimension.id === 'A1_theory_structure')
  if (aKnowledge && aKnowledge.answeredItems > 0) {
    limitations.push(
      `理论熟悉度（A1）单次仅 ${aKnowledge.answeredItems} 题，属于低精度提示（low sample），不能当作理论水平或政治资格的评定。`,
    )
  }
  limitations.push(...measurementNoticeLimitations(pack))
  for (const note of consistencyDraft.notes) limitations.push(note)

  const stages: SamplerStageReport[] = [...samplerStages]

  return {
    id: `${session.id}::result`,
    sessionId: session.id,
    generatedAt,
    versions: {
      questionPack: `${pack.id}@${pack.version}`,
      scoring: `${scoring.id}@${scoring.version}`,
      roleModel: `${roleModel.id}@${roleModel.version}`,
    },
    dimensions,
    aLayerProfile: buildALayerProfile({ paper, session, scoring, dimensions }),
    roleFits,
    strengths,
    developmentAreas,
    consistency: {
      answerConsistency: consistencyDraft.answerConsistency,
      extremeRepeatRate: consistencyDraft.extremeRepeatRate,
      findings: consistencyDraft.findings,
      needsFurtherUnderstanding: consistencyDraft.needsFurtherUnderstanding,
      notes: consistencyDraft.notes,
    },
    evidence,
    samplerStages: stages,
    limitations,
  }
}
