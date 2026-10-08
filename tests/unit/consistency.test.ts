import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  analyseConsistency,
  consistencyPenalty,
  CONSISTENCY_LABELS,
  type ConsistencyState,
} from '../../src/engine/consistency.ts'
import { fixtureScoringModel } from '../fixtures/packs.ts'

const bundle = loadContentBundle()

function state(entries: Record<string, number | null>, maxSignal = 3): ConsistencyState {
  const signalByQuestion = new Map(Object.entries(entries))
  const maxSignalByQuestion = new Map(Object.keys(entries).map((id) => [id, maxSignal]))
  return { signalByQuestion, maxSignalByQuestion, paperQuestionIds: new Set(Object.keys(entries)) }
}

describe('consistency — vocabulary boundary (Engineering Bible §18)', () => {
  it('never emits deception vocabulary in any produced string', () => {
    const model = bundle.scoring
    const samples = [
      analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 0 })),
      analyseConsistency(fixtureScoringModel, state({ B1Q1: 1, B2Q1: 1 })),
      analyseConsistency(fixtureScoringModel, state({ B1Q1: 3 })),
      analyseConsistency(fixtureScoringModel, state({ B1Q1: null, B2Q1: null })),
      analyseConsistency(fixtureScoringModel, state({ A1Q1: 3, A2Q1: 0 })),
    ]
    const forbidden = ['撒谎', '欺骗', '真实性评分', '说谎', '诚实度', 'lying', 'deception']
    for (const draft of samples) {
      const serialised = JSON.stringify(draft)
      for (const word of forbidden) {
        expect(serialised).not.toContain(word)
      }
    }
    expect(model.confidence.rule).toContain('Never infer deception')
  })

  it('uses the three permitted labels for a directional pair', () => {
    const consistent = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 3 }))
    expect(consistent.findings[0]?.label).toBe(CONSISTENCY_LABELS.stable)

    const mild = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 2 }))
    expect(mild.findings[0]?.label).toBe(CONSISTENCY_LABELS.mildGap)

    const large = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 0 }))
    expect(large.findings[0]?.label).toBe(CONSISTENCY_LABELS.largeGap)
  })
})

describe('consistency — findings', () => {
  it('flags a large gap as a hard conflict and a mild gap as not', () => {
    const large = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 0 }))
    expect(large.findings[0]?.isHardConflict).toBe(true)
    expect(large.needsFurtherUnderstanding).toBe(true)

    const mild = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 2 }))
    expect(mild.findings[0]?.isHardConflict).toBe(false)
    expect(mild.needsFurtherUnderstanding).toBe(false)
  })

  it('treats a complementary pair as informative, never as a conflict', () => {
    const draft = analyseConsistency(fixtureScoringModel, state({ A1Q1: 3, A2Q1: 0 }))
    const complementary = draft.findings.find((finding) => finding.groupId === 'TG02')
    expect(complementary?.type).toBe('complementary')
    expect(complementary?.label).toBe(CONSISTENCY_LABELS.complementary)
    expect(complementary?.isHardConflict).toBe(false)
    expect(complementary?.confidencePenalty).toBe(0)
  })

  it('reports a group that the paper did not cover as incomparable, not as a problem', () => {
    const draft = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3 }))
    const finding = draft.findings.find((entry) => entry.groupId === 'TG01')
    expect(finding?.label).toBe(CONSISTENCY_LABELS.singleSided)
    expect(finding?.confidencePenalty).toBe(0)
  })

  it('reports unanswered pairs without penalising them', () => {
    const draft = analyseConsistency(fixtureScoringModel, state({ B1Q1: null, B2Q1: null }))
    const finding = draft.findings.find((entry) => entry.groupId === 'TG01')
    expect(finding?.label).toBe(CONSISTENCY_LABELS.unanswered)
    expect(finding?.confidencePenalty).toBe(0)
  })

  it('measures answer consistency as one minus the mean normalised gap', () => {
    const perfect = analyseConsistency(
      fixtureScoringModel,
      state({ B1Q1: 3, B2Q1: 3, A1Q1: 2, A2Q1: 2 }),
    )
    expect(perfect.answerConsistency).toBe(1)

    const worst = analyseConsistency(fixtureScoringModel, state({ B1Q1: 3, B2Q1: 0 }))
    expect(worst.answerConsistency).toBe(0)
  })

  it('detects extreme repeated choice only via the answering pattern', () => {
    const allTop = analyseConsistency(
      fixtureScoringModel,
      state({ B1Q1: 3, B2Q1: 3, A1Q1: 3, A2Q1: 3, C1Q1: 3 }),
    )
    expect(allTop.extremeRepeatRate).toBe(1)
    expect(allTop.needsFurtherUnderstanding).toBe(true)
    expect(allTop.notes.join(' ')).toContain('作答倾向')

    const mixed = analyseConsistency(
      fixtureScoringModel,
      state({ B1Q1: 3, B2Q1: 1, A1Q1: 1, A2Q1: 3 }),
    )
    expect(mixed.extremeRepeatRate).toBe(0.5)
    expect(mixed.notes.join(' ')).not.toContain('作答倾向')
  })

  it('clamps the aggregate penalty so many findings cannot zero out confidence', () => {
    const draft = analyseConsistency(
      fixtureScoringModel,
      state({ B1Q1: 3, B2Q1: 0, A1Q1: 3, A2Q1: 0 }),
    )
    const penalty = consistencyPenalty(draft)
    expect(penalty).toBeGreaterThan(0)
    expect(penalty).toBeLessThanOrEqual(0.45)
  })
})

describe('consistency — real bank wiring', () => {
  it('produces one finding per declared group and keeps every group id', () => {
    const draft = analyseConsistency(
      bundle.scoring,
      state(
        Object.fromEntries(
          bundle.scoring.confidence.consistencyGroups.flatMap((group) =>
            group.questions.map((questionId) => [questionId, 2]),
          ),
        ),
      ),
    )
    expect(draft.findings).toHaveLength(bundle.scoring.confidence.consistencyGroups.length)
    expect(new Set(draft.findings.map((finding) => finding.groupId)).size).toBe(
      bundle.scoring.confidence.consistencyGroups.length,
    )
  })
})
