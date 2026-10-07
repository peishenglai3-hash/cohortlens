import type { ScoringModel } from '../domain/schemas.ts'

/**
 * Consistency Engine — Engineering Bible §18.
 *
 * Allowed: detecting differences between similar items, reverse-item conflicts, obviously
 * mutually exclusive answers, and extreme repeated choices.
 * Required naming: 回答一致性 / 回答稳定度 / 需要进一步了解.
 * Forbidden: 撒谎概率 / 欺骗指数 / 真实性评分.
 *
 * The vocabulary in this file is therefore deliberately non-accusatory: a finding describes a
 * property of the *answer sheet*, never of the person. The engine never claims to detect lying;
 * it reports that two answers point in different directions and marks the pair for human
 * follow-up.
 */

export interface ComparableAnswer {
  questionId: string
  /** Chosen option id, or null when unanswered. */
  optionId: string | null
  /** Signal value for the question's own dimension (0..maxPerQuestion). */
  signal: number | null
}

export interface ConsistencyState {
  /** questionId -> the chosen option's signal, null when unanswered. */
  signalByQuestion: Map<string, number | null>
  /** Highest signal reachable on each question (normally 3). */
  maxSignalByQuestion: Map<string, number>
  /** questionIds actually drawn into this paper. */
  paperQuestionIds: Set<string>
}

export interface ConsistencyFindingDraft {
  groupId: string
  type: 'directional_alignment' | 'complementary'
  note: string
  questionIds: string[]
  label: string
  detail: string
  confidencePenalty: number
  isHardConflict: boolean
}

export interface ConsistencyDraft {
  answerConsistency: number
  extremeRepeatRate: number
  findings: ConsistencyFindingDraft[]
  needsFurtherUnderstanding: boolean
  notes: string[]
}

export const CONSISTENCY_LABELS = {
  stable: '两题回答方向一致',
  mildGap: '两题回答方向略有差异',
  largeGap: '两题回答方向差异较大',
  complementary: '两题回答互补，不构成冲突',
  singleSided: '只有一题在本次问卷中，无法比对',
  unanswered: '存在未作答题目',
} as const

function formatPair(questionIds: readonly string[]): string {
  return questionIds.join(' / ')
}

/**
 * @param model       scoring model, source of the consistency groups
 * @param state       the paper's answers expressed as signals
 */
export function analyseConsistency(model: ScoringModel, state: ConsistencyState): ConsistencyDraft {
  const findings: ConsistencyFindingDraft[] = []
  const notes: string[] = []
  const maxSignal = model.scale.maxPerQuestion
  const gaps: number[] = []

  for (const group of model.confidence.consistencyGroups) {
    const inPaper = group.questions.filter((questionId) => state.paperQuestionIds.has(questionId))
    const answered = inPaper.filter((questionId) => {
      const signal = state.signalByQuestion.get(questionId)
      return signal !== null && signal !== undefined
    })

    if (inPaper.length < 2) {
      findings.push({
        groupId: group.id,
        type: group.type,
        note: group.note,
        questionIds: [...group.questions],
        label: CONSISTENCY_LABELS.singleSided,
        detail: `本组两题中只有 ${formatPair(inPaper)} 进入本次问卷，无法比对。这不代表回答有问题，只代表本次抽样没有覆盖到配对的另一题。`,
        confidencePenalty: 0,
        isHardConflict: false,
      })
      continue
    }

    if (answered.length < 2) {
      findings.push({
        groupId: group.id,
        type: group.type,
        note: group.note,
        questionIds: [...group.questions],
        label: CONSISTENCY_LABELS.unanswered,
        detail: `本组题目 ${formatPair(group.questions)} 存在未作答项，未参与一致性比对。`,
        confidencePenalty: 0,
        isHardConflict: false,
      })
      continue
    }

    const signals = answered.map((questionId) => state.signalByQuestion.get(questionId) ?? 0)
    const gap = Math.abs((signals[0] ?? 0) - (signals[1] ?? 0))
    const normalisedGap = maxSignal > 0 ? gap / maxSignal : 0
    gaps.push(normalisedGap)

    if (group.type === 'complementary') {
      findings.push({
        groupId: group.id,
        type: group.type,
        note: group.note,
        questionIds: [...group.questions],
        label: CONSISTENCY_LABELS.complementary,
        detail: `本组是互补题（不是同一件事的两种问法），分值差异 ${gap} 分只作参考，不视为冲突。规则备注：${group.note}`,
        confidencePenalty: 0,
        isHardConflict: false,
      })
      continue
    }

    if (gap === 0) {
      findings.push({
        groupId: group.id,
        type: group.type,
        note: group.note,
        questionIds: [...group.questions],
        label: CONSISTENCY_LABELS.stable,
        detail: `两题回答指向同一方向（差值 0）。规则备注：${group.note}`,
        confidencePenalty: 0,
        isHardConflict: false,
      })
      continue
    }

    const large = gap >= 2
    findings.push({
      groupId: group.id,
      type: group.type,
      note: group.note,
      questionIds: [...group.questions],
      label: large ? CONSISTENCY_LABELS.largeGap : CONSISTENCY_LABELS.mildGap,
      detail: large
        ? `两题回答方向差异较大（差值 ${gap}/${maxSignal}），建议在人工复核时进一步了解这两题的原始回答。规则备注：${group.note}`
        : `两题回答方向略有差异（差值 ${gap}/${maxSignal}），不足以单独说明问题。规则备注：${group.note}`,
      confidencePenalty: Math.min(0.3, normalisedGap * 0.3),
      isHardConflict: large,
    })
  }

  const comparableGroups = findings.filter(
    (finding) =>
      finding.label !== CONSISTENCY_LABELS.singleSided && finding.type === 'directional_alignment',
  )
  const answerConsistency =
    comparableGroups.length === 0
      ? 1
      : 1 - gaps.reduce((sum, gap) => sum + gap, 0) / Math.max(1, gaps.length)

  const answeredSignals = [...state.paperQuestionIds]
    .map((questionId) => state.signalByQuestion.get(questionId))
    .filter((signal): signal is number => signal !== null && signal !== undefined)

  const extremeRepeatRate =
    answeredSignals.length === 0
      ? 0
      : answeredSignals.filter((signal) => signal === maxSignal).length / answeredSignals.length

  if (extremeRepeatRate >= 0.7) {
    notes.push(
      `本次问卷中有 ${(extremeRepeatRate * 100).toFixed(0)}% 的题目选择了最高分档。单一作答倾向（习惯性选择最高档）会削弱各维度之间的区分度，这不构成"真实性"判断，只提示回看原始回答时注意作答方式。`,
    )
  }

  const hardConflicts = findings.filter((finding) => finding.isHardConflict)
  if (hardConflicts.length > 0) {
    notes.push(
      `有 ${hardConflicts.length} 组配对题回答方向差异较大（${hardConflicts
        .map((finding) => finding.groupId)
        .join(
          '、',
        )}）。系统只把相关维度的置信度下调，并建议人工进一步了解，不据此判断回答是否"真实"。`,
    )
  }

  return {
    answerConsistency,
    extremeRepeatRate,
    findings,
    needsFurtherUnderstanding: hardConflicts.length > 0 || extremeRepeatRate >= 0.7,
    notes,
  }
}

/** Total multiplicative confidence penalty implied by the findings, clamped to [0, 0.45]. */
export function consistencyPenalty(draft: ConsistencyDraft): number {
  const total = draft.findings.reduce((sum, finding) => sum + finding.confidencePenalty, 0)
  return Math.min(0.45, total)
}
