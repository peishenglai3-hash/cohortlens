import type { AssessmentResult, AssessmentSession } from '../src/domain/schemas.ts'
import type { ReviewSummary, SubmissionCore } from '../src/domain/submission.ts'

/**
 * 审阅摘要派生 —— 纯函数，无 IO，因此可以完整单测。
 *
 * 这一步是**整个审阅台的关键判断点**，所以把它单独拆出来并写清楚它在做什么、不做什么：
 *
 * 它做：把一份几百 KB 的提交压成审阅人在列表页需要看到的十几个数字与标签（材料完成度、
 * 薄维度、一致性提示、维度画像、角色适配、A 层六部分原文），并保留人工结论位。
 *
 * 它**不做**：给出"这个人合不合适"。摘要里没有 recommendation / verdict / pass / rank
 * 这类字段，而且 `tests/unit/submission-contract.test.ts` 会断言它们不存在。这不是遗漏——
 * 加一个这样的字段就等于把"系统不输出录用或淘汰建议"这条产品边界搬到了后端，而那条边界
 * 恰恰是让这个工具可以被正当使用的前提。
 */

export interface SummarizeInput {
  submissionId: string
  receivedAt: string
  inviteLabel: string
  contact: { kind: 'email' | 'phone'; value: string } | null
  core: SubmissionCore
  /**
   * questionId -> dimensionId，来自提交物里自带的题库快照。
   *
   * 为什么需要它：要判断"这一维缺了多少材料"，必须知道本次卷子里每一维**应该**有几题。
   * 而这个信息只有把 questionIds 映射回维度才能得到。映射由提交物自身的题干提供，
   * 所以审阅台不需要再去加载一份可能已经换代的题库。
   */
  dimensionOf: ReadonlyMap<string, string>
}

/** 从会话里数出实际作答的题量。以选项 id 非空为准，空串也算未作答。 */
export function countAnswered(session: AssessmentSession): number {
  return Object.values(session.answers ?? {}).filter(
    (optionId) => typeof optionId === 'string' && optionId.length > 0,
  ).length
}

/**
 * Build the questionId -> dimensionId map from the submission itself.
 *
 * The map is reconstructed from `result.evidence` (which carries one entry per answered question)
 * plus each dimension's `evidenceQuestionIds`, rather than from a question pack. That matters: the
 * console may open a submission weeks after the pack was replaced, and it must still read the old
 * material correctly instead of mapping old ids through a new pack.
 */
export function buildDimensionMap(core: SubmissionCore): Map<string, string> {
  const map = new Map<string, string>()
  for (const dimension of core.result.dimensions) {
    for (const questionId of dimension.evidenceQuestionIds) {
      map.set(questionId, dimension.id)
    }
  }
  for (const evidence of core.result.evidence) {
    map.set(evidence.questionId, evidence.dimension)
  }
  return map
}

/**
 * 材料充分度。
 *
 * 三个决定都是被测试逼出来的：
 *
 *   1. **分母用 `session.questionIds.length`**（本次实际抽到的题量），不是题库总量。一次只抽
 *      30 题的测评，用 120 做分母会得到 25% 的完成度，看起来像"这人没答完"，其实他答完了抽到的全部。
 *   2. **作答数从 session 现算，不读 result。** 第一版读的是 `result.dimensions[].answeredItems`，
 *      那是"完成测评那一刻"的快照。拿它去比对一份被拿掉一题的材料，永远比不出差异——
 *      而这个函数存在的意义恰恰是回答"这份材料缺了什么"。
 *   3. **"缺材料"的判据是该维的预期题量**（本次卷子里该维实际抽了几题），不是"作答数 <= 2"。
 *      真实数据上 B/C 每维本来就只有 1-2 题，用后者会让几乎每一维都命中：一个永远在报的告警
 *      等于没有告警，还会把"某一维完全没答"这种真问题淹掉。
 */
export function deriveMaterial(
  session: AssessmentSession,
  result: AssessmentResult,
  dimensionOf: ReadonlyMap<string, string>,
) {
  const answeredIds = Object.entries(session.answers ?? {})
    .filter(([, optionId]) => typeof optionId === 'string' && optionId.length > 0)
    .map(([questionId]) => questionId)

  const answeredByDimension = new Map<string, number>()
  const expectedByDimension = new Map<string, number>()

  for (const questionId of session.questionIds) {
    const dimension = dimensionOf.get(questionId)
    if (!dimension) continue
    expectedByDimension.set(dimension, (expectedByDimension.get(dimension) ?? 0) + 1)
  }
  for (const questionId of answeredIds) {
    const dimension = dimensionOf.get(questionId)
    if (!dimension) continue
    answeredByDimension.set(dimension, (answeredByDimension.get(dimension) ?? 0) + 1)
  }

  /**
   * The dimension list comes from the result, so ordering and labels match the rest of the console.
   * Any dimension that only appears in the paper is appended rather than silently dropped.
   */
  const dimensionIds = [
    ...new Set([
      ...result.dimensions.map((dimension) => dimension.id),
      ...expectedByDimension.keys(),
    ]),
  ]

  const coverage = dimensionIds.map((dimension) => ({
    dimension,
    answeredItems: answeredByDimension.get(dimension) ?? 0,
    expectedItems: expectedByDimension.get(dimension) ?? 0,
  }))

  const answeredItems = answeredIds.length
  const totalItems = session.questionIds.length

  return {
    answeredItems,
    totalItems,
    completionRatio: totalItems > 0 ? Math.min(1, answeredItems / totalItems) : 0,
    thinDimensions: coverage
      .filter((entry) => entry.expectedItems > 0 && entry.answeredItems < entry.expectedItems)
      .map((entry) => entry.dimension),
    coverage,
    needsFurtherUnderstanding: result.consistency.needsFurtherUnderstanding,
  }
}

/**
 * 维度呈现策略的兜底。
 *
 * `scoringKind` 是 A 层 V1.1 引入的字段，V1.0 的结果里没有。这里按"这个人交的是什么版本"来推：
 * 非 A 层在 V1.0/V1.1 都是数值型；A 层缺少 `scoringKind` 时按 `categorical` 处理最保守——
 * 宁可把 A 层维度标成"没有可比分数"，也不要把一份自报材料显示成一个可比的分数。
 */
function resolveScoringKind(dimension: {
  layer: string
  scoringKind?: string | undefined
}): 'numeric' | 'knowledge' | 'categorical' | 'descriptive' {
  if (
    dimension.scoringKind === 'numeric' ||
    dimension.scoringKind === 'knowledge' ||
    dimension.scoringKind === 'categorical' ||
    dimension.scoringKind === 'descriptive'
  ) {
    return dimension.scoringKind
  }
  return dimension.layer === 'theory_value' ? 'categorical' : 'numeric'
}

export function summarizeSubmission({
  submissionId,
  receivedAt,
  inviteLabel,
  contact,
  core,
  dimensionOf,
}: SummarizeInput): ReviewSummary {
  const { session, result } = core

  const dimensions = result.dimensions.map((dimension) => ({
    id: dimension.id,
    label: dimension.label,
    layer: dimension.layer,
    scoringKind: resolveScoringKind(dimension),
    normalizedScore: dimension.normalizedScore,
    band: dimension.band,
    answeredItems: dimension.answeredItems,
    confidence: dimension.confidence,
  }))

  const roleFits = result.roleFits.map((fit) => ({
    roleId: fit.roleId,
    name: fit.name,
    fitScore: fit.fitScore,
    coverage: fit.coverage,
    contributingDimensions: [...fit.contributingDimensions],
  }))

  const profile = result.aLayerProfile
  const aLayer = profile
    ? {
        declaredIdentity: profile.declaredIdentity.map((item) => ({
          topic: item.topic,
          selectedCategory: item.selectedCategory,
          selectedText: item.selectedText,
        })),
        theoryFamiliarity: profile.theoryFamiliarity
          ? {
              correct: profile.theoryFamiliarity.correct,
              answered: profile.theoryFamiliarity.answered,
              lowSample: profile.theoryFamiliarity.lowSample,
            }
          : null,
        issuePositions: [
          ...profile.politicalEconomy.map((card) => ({
            dimension: 'A2_political_economy',
            topic: card.topic,
            selectedText: card.selectedText,
          })),
          ...profile.socialPolitical.map((card) => ({
            dimension: 'A3_social_political',
            topic: card.topic,
            selectedText: card.selectedText,
          })),
          ...profile.practiceOrientation.map((card) => ({
            dimension: 'A4_practice_orientation',
            topic: card.topic,
            selectedText: card.selectedText,
          })),
        ],
        reflexivity: {
          state: profile.reflexivity.state,
          confidence: profile.reflexivity.confidence,
        },
        boundaries: [...profile.boundaries],
      }
    : null

  return {
    submissionId,
    receivedAt,
    assessedAt: core.assessedAt,
    inviteLabel,
    contact,
    versions: { ...core.versions },
    material: deriveMaterial(session, result, dimensionOf),
    dimensions,
    roleFits,
    aLayer,
    limitations: [...result.limitations],
    decision: null,
  }
}

/** 服务端派生的提交 id 主体：稳定、可读、不暴露自增信息。 */
export function deriveSubmissionId(clientSubmissionId: string, inviteCodeId: string): string {
  // 幂等键与邀请码一起构成主键：同一个人拿两个不同批次的码提交两次，应当产生两条记录，
  // 因为那确实是两次不同的委托关系。
  return `${inviteCodeId}:${clientSubmissionId}`
}
