import { describe, expect, it } from 'vitest'
import { LAYERS, type Layer } from '../../src/domain/schemas.ts'
import { sampleQuestionSet, SamplerError, shuffleOptions } from '../../src/engine/sampler.ts'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  trimmedPack,
  trimmedScoring,
  trimmedWidePack,
  fixturePack,
  fixtureScoringModel,
} from '../fixtures/packs.ts'

const bundle = loadContentBundle()
const { pack, scoring } = bundle

function countByLayer(questionIds: readonly string[]): Record<Layer, number> {
  const byId = new Map(pack.questions.map((question) => [question.id, question]))
  const counts: Record<Layer, number> = {
    theory_value: 0,
    cooperation_behavior: 0,
    skill_role: 0,
  }
  for (const questionId of questionIds) {
    const question = byId.get(questionId)
    if (question) counts[question.layer] += 1
  }
  return counts
}

describe('sampler — layer quota (Engineering Bible §11)', () => {
  it('always draws exactly totalQuestions, all distinct', () => {
    for (let index = 0; index < 300; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `quota-${index}` })
      expect(result.questionIds).toHaveLength(pack.assessmentPolicy.totalQuestions)
      expect(new Set(result.questionIds).size).toBe(result.questionIds.length)
    }
  })

  it('always satisfies 15 / 9 / 6', () => {
    for (let index = 0; index < 300; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `layers-${index}` })
      expect(countByLayer(result.questionIds)).toEqual({
        theory_value: 15,
        cooperation_behavior: 9,
        skill_role: 6,
      })
    }
  })

  it('splits layer A strictly by the pack-declared per-dimension quota', () => {
    const quota = pack.assessmentPolicy.subQuota?.theory_value
    expect(quota, 'the active pack must declare an A-layer subQuota').toBeDefined()
    const dimensions = Object.keys(scoring.layerA.dimensions)
    const byId = new Map(pack.questions.map((question) => [question.id, question]))
    for (let index = 0; index < 300; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `layerA-${index}` })
      const counts = new Map<string, number>()
      for (const questionId of result.questionIds) {
        const question = byId.get(questionId)
        if (question?.layer !== 'theory_value') continue
        counts.set(question.dimension, (counts.get(question.dimension) ?? 0) + 1)
      }
      /**
       * Every declared A dimension appears exactly as often as the pack declares. No rotation, no
       * shortfall: A-layer V1.1's six dimensions carry different kinds of evidence, so they are not
       * interchangeable slots the way V1.0's four macro dimensions were (ADR-018).
       */
      for (const dimension of dimensions) {
        expect(counts.get(dimension), `seed layerA-${index} dimension ${dimension}`).toBe(
          quota?.[dimension],
        )
      }
      expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(
        pack.assessmentPolicy.quota.theory_value,
      )
      expect(result.layerAShortDimension).toBeNull()
    }
  })

  it('covers every declared dimension in every layer', () => {
    for (let index = 0; index < 200; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `coverage-${index}` })
      const byId = new Map(pack.questions.map((question) => [question.id, question]))
      for (const layer of LAYERS) {
        const key =
          layer === 'theory_value'
            ? 'layerA'
            : layer === 'cooperation_behavior'
              ? 'layerB'
              : 'layerC'
        const declared = new Set(Object.keys(scoring[key].dimensions))
        const drawn = new Set(
          result.questionIds
            .map((questionId) => byId.get(questionId))
            .filter((question) => question?.layer === layer)
            .map((question) => question?.dimension),
        )
        for (const dimension of declared) {
          expect(drawn.has(dimension)).toBe(true)
        }
      }
    }
  })

  it('keeps layer C at exactly one item per dimension', () => {
    for (let index = 0; index < 200; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `layerC-${index}` })
      const byId = new Map(pack.questions.map((question) => [question.id, question]))
      const counts = new Map<string, number>()
      for (const questionId of result.questionIds) {
        const question = byId.get(questionId)
        if (question?.layer !== 'skill_role') continue
        counts.set(question.dimension, (counts.get(question.dimension) ?? 0) + 1)
      }
      expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1])
    }
  })

  it('spreads layer B as evenly as 9 items over 6 dimensions allows', () => {
    for (let index = 0; index < 200; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `layerB-${index}` })
      const byId = new Map(pack.questions.map((question) => [question.id, question]))
      const counts = new Map<string, number>()
      for (const questionId of result.questionIds) {
        const question = byId.get(questionId)
        if (question?.layer !== 'cooperation_behavior') continue
        counts.set(question.dimension, (counts.get(question.dimension) ?? 0) + 1)
      }
      const values = [...counts.values()].sort((a, b) => a - b)
      expect(counts.size).toBe(6)
      // 9 items over 6 dimensions: three dimensions get 2, three get 1.
      expect(values.reduce((sum, value) => sum + value, 0)).toBe(9)
      expect(values.every((value) => value === 1 || value === 2)).toBe(true)
      expect(values.filter((value) => value === 2)).toHaveLength(3)
    }
  })
})

describe('sampler — reproducibility (Engineering Bible §12)', () => {
  it('is a pure function of the seed', () => {
    const a = sampleQuestionSet({ pack, scoring, seed: 'stable-seed' })
    const b = sampleQuestionSet({ pack, scoring, seed: 'stable-seed' })
    expect(a.questionIds).toEqual(b.questionIds)
    expect(a.layerAShortDimension).toBe(b.layerAShortDimension)
  })

  it('produces different papers for different seeds', () => {
    const papers = new Set(
      Array.from({ length: 40 }, (_, index) =>
        sampleQuestionSet({ pack, scoring, seed: `variety-${index}` }).questionIds.join(','),
      ),
    )
    expect(papers.size).toBe(40)
  })

  it('never uses Math.random', () => {
    // A guard against a future refactor silently reintroducing nondeterminism.
    const original = Math.random
    Math.random = () => {
      throw new Error('sampler touched Math.random')
    }
    try {
      expect(() => sampleQuestionSet({ pack, scoring, seed: 'no-math-random' })).not.toThrow()
      expect(() => shuffleOptions(pack, ['A001', 'B001', 'C001'], 'no-math-random')).not.toThrow()
    } finally {
      Math.random = original
    }
  })

  it('rejects an empty seed', () => {
    expect(() => sampleQuestionSet({ pack, scoring, seed: '  ' })).toThrow(SamplerError)
  })

  it('draws a different paper every time but never a different quota', () => {
    // The A-layer split is fixed by the pack, so unlike V1.0 there is nothing to rotate. What must
    // still vary is which questions fill those slots.
    const papers = new Set<string>()
    for (let index = 0; index < 100; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `vary-${index}` })
      papers.add([...result.questionIds].sort().join(','))
    }
    expect(papers.size).toBe(100)
  })

  it('ignores legacy previousSessions instead of misreading them', () => {
    // V1.0 sessions carried a rotating shortfall. V1.1 has none, so passing old history must not
    // change the declared quota or throw.
    const baseline = sampleQuestionSet({ pack, scoring, seed: 'legacy-baseline' })
    const withHistory = sampleQuestionSet({
      pack,
      scoring,
      seed: 'legacy-baseline',
      previousSessions: [{ seed: 'old', shortDimension: 'conceptual_understanding' }],
    })
    expect(withHistory.questionIds).toEqual(baseline.questionIds)
    expect(withHistory.layerAShortDimension).toBeNull()
  })
})

describe('sampler — stage reporting', () => {
  it('reports every Engineering Bible §10 stage, marking inert ones inactive', () => {
    const result = sampleQuestionSet({ pack, scoring, seed: 'stages' })
    const byStageName = new Map(result.stages.map((stage) => [stage.stage, stage]))
    for (const expected of [
      'layer_partition',
      'subdimension_coverage',
      'family_conflict_filtering',
      'difficulty_balance',
      'semantic_exclusion',
      'seeded_sampling',
      'final_question_set',
    ]) {
      expect(byStageName.has(expected)).toBe(true)
    }
    /**
     * Under the active V1.1 pack the family stage is now *active* (the A layer shares families across
     * sub-topics) and the difficulty stage is active too (the A layer carries three levels). Only
     * semantic exclusion stays inert, because the pack declares no exclusion rules.
     */
    expect(byStageName.get('family_conflict_filtering')?.active).toBe(true)
    expect(byStageName.get('difficulty_balance')?.active).toBe(true)
    expect(byStageName.get('semantic_exclusion')?.active).toBe(false)
    expect(byStageName.get('layer_partition')?.active).toBe(true)
    expect(byStageName.get('seeded_sampling')?.active).toBe(true)
    for (const stage of result.stages) {
      expect(stage.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('sampler — failure modes surface loudly', () => {
  it('rejects a bank whose layer pool is smaller than the quota', () => {
    const shrunk = {
      ...pack,
      questions: pack.questions.filter((question) => question.layer !== 'skill_role'),
    }
    expect(() => sampleQuestionSet({ pack: shrunk, scoring, seed: 'too-small' })).toThrow(
      SamplerError,
    )
  })

  it('rejects a dimension the scoring model does not declare', () => {
    const tampered = {
      ...pack,
      questions: pack.questions.map((question) =>
        question.id === 'A001' ? { ...question, dimension: 'not_a_real_dimension' } : question,
      ),
    }
    expect(() => sampleQuestionSet({ pack: tampered, scoring, seed: 'unknown-dim' })).toThrow(
      /未声明/,
    )
  })
})

describe('sampler — layer-A plan arithmetic', () => {
  /**
   * A pack carrying four items in each of two layer-A dimensions, with the other two declared
   * dimensions absent. Declared per-dimension targets are supplied per test so both the growth
   * and the trim branch of the planner can be exercised against a quota of 4.
   */
  function buildTwoDimensionPack(declared: { a_one: number; a_two: number }) {
    return {
      ...trimmedPack,
      assessmentPolicy: {
        ...trimmedPack.assessmentPolicy,
        quota: { theory_value: 4, cooperation_behavior: 0, skill_role: 0 },
        totalQuestions: 4,
        subQuota: {
          theory_value: declared,
          cooperation_behavior: {
            minimumPerDimension: 0,
            remaining: 0,
            strategy: 'balanced_random' as const,
          },
          skill_role: { exactlyPerDimension: 0 },
        },
      },
    }
  }

  it('refuses a pack whose A subQuota does not sum to the layer quota', () => {
    // A-layer V1.1 reads the quota verbatim instead of deriving it. A pack that declares a
    // contradictory total is rejected rather than silently rescaled, because rescaling would change
    // the information budget the author chose.
    const packTooSmall = buildTwoDimensionPack({ a_one: 1, a_two: 1 })
    expect(() =>
      sampleQuestionSet({ pack: packTooSmall, scoring: trimmedScoring, seed: 'grow-plan' }),
    ).toThrow(/A 层配额之和 2 不等于层级配额 4/)

    const packTooLarge = buildTwoDimensionPack({ a_one: 3, a_two: 3 })
    expect(() =>
      sampleQuestionSet({ pack: packTooLarge, scoring: trimmedScoring, seed: 'trim-plan' }),
    ).toThrow(/A 层配额之和 6 不等于层级配额 4/)
  })

  it('draws exactly the declared per-dimension split when the totals agree', () => {
    const packOk = buildTwoDimensionPack({ a_one: 2, a_two: 2 })
    const result = sampleQuestionSet({ pack: packOk, scoring: trimmedScoring, seed: 'exact-plan' })
    expect(result.questionIds).toHaveLength(4)
    const byId = new Map(packOk.questions.map((question) => [question.id, question]))
    const perDimension = new Map<string, number>()
    for (const questionId of result.questionIds) {
      const question = byId.get(questionId)
      if (!question) continue
      perDimension.set(question.dimension, (perDimension.get(question.dimension) ?? 0) + 1)
    }
    expect(perDimension.get('a_one')).toBe(2)
    expect(perDimension.get('a_two')).toBe(2)
  })

  it('refuses a pack that omits a declared dimension from its subQuota', () => {
    const packMissing = {
      ...trimmedWidePack,
      assessmentPolicy: {
        ...trimmedWidePack.assessmentPolicy,
        quota: { theory_value: 4, cooperation_behavior: 0, skill_role: 0 },
        totalQuestions: 4,
        subQuota: {
          // `a_two` is declared by the scoring model but has no quota here.
          theory_value: { a_one: 4 },
          cooperation_behavior: {
            minimumPerDimension: 0,
            remaining: 0,
            strategy: 'balanced_random' as const,
          },
          skill_role: { exactlyPerDimension: 0 },
        },
      },
    }
    expect(() =>
      sampleQuestionSet({ pack: packMissing, scoring: trimmedScoring, seed: 'missing-quota' }),
    ).toThrow(/未在 assessmentPolicy.subQuota.theory_value 中声明单次配额/)
  })

  it('refuses a pack that uses dimensions the scoring model never declared', () => {
    // The pack only carries the two layer-A dimensions; the shipped scoring model declares four
    // and has empty layer-B/C pools, so it must be refused loudly rather than silently drawing a
    // smaller paper.
    expect(() => sampleQuestionSet({ pack: trimmedPack, scoring, seed: 'partial' })).toThrow(
      /出现评分模型未声明的维度/,
    )
  })

  it('refuses a pack whose declared dimension has no items at all', () => {
    const packGap = {
      ...trimmedWidePack,
      questions: trimmedWidePack.questions.filter((question) => question.dimension !== 'a_two'),
      assessmentPolicy: {
        ...trimmedWidePack.assessmentPolicy,
        quota: { theory_value: 4, cooperation_behavior: 0, skill_role: 0 },
        totalQuestions: 4,
        subQuota: {
          theory_value: { a_one: 2, a_two: 2 },
          cooperation_behavior: {
            minimumPerDimension: 0,
            remaining: 0,
            strategy: 'balanced_random' as const,
          },
          skill_role: { exactlyPerDimension: 0 },
        },
      },
    }
    expect(() =>
      sampleQuestionSet({ pack: packGap, scoring: trimmedScoring, seed: 'gap' }),
    ).toThrow(/题库只有 0 题/)
  })
})

describe('sampler — family conflict filtering has real work to do on a fixture with shared families', () => {
  it('never places two questions of the same family in one paper, and tops the paper back up', () => {
    for (let index = 0; index < 60; index += 1) {
      const result = sampleQuestionSet({
        pack: fixturePack,
        scoring: fixtureScoringModel,
        seed: `family-${index}`,
      })
      expect(result.questionIds).toHaveLength(fixturePack.assessmentPolicy.totalQuestions)
      expect(new Set(result.questionIds).size).toBe(result.questionIds.length)
      const byId = new Map(fixturePack.questions.map((question) => [question.id, question]))
      const families = result.questionIds
        .map((questionId) => byId.get(questionId)?.familyId)
        .filter((familyId): familyId is string => Boolean(familyId))
      expect(new Set(families).size).toBe(families.length)
    }
  })

  it('reports the family stage as active for this pack, and the difficulty stage stays inert when only two levels survive per layer', () => {
    const result = sampleQuestionSet({
      pack: fixturePack,
      scoring: fixtureScoringModel,
      seed: 'stages-fixture',
    })
    const byName = new Map(result.stages.map((stage) => [stage.stage, stage]))
    expect(byName.get('family_conflict_filtering')?.active).toBe(true)
    // The fixture's layer-B pool holds a single difficulty level, so the stage reports honestly.
    expect(byName.get('difficulty_balance')?.reason.length).toBeGreaterThan(0)
  })
})

describe('sampler — layer B remainder has no double-sample path', () => {
  it('draws the minimum per dimension when the pack declares no remainder', () => {
    // Two B dimensions with one item each. The fixture policy declares `remaining: 0`, so the
    // valid outcome is a two-item B layer rather than a crash.
    const narrowB = {
      ...fixturePack,
      questions: fixturePack.questions.filter(
        (question) =>
          question.layer !== 'cooperation_behavior' ||
          question.id === 'B1Q1' ||
          question.id === 'B2Q1',
      ),
    }
    const result = sampleQuestionSet({
      pack: narrowB,
      scoring: fixtureScoringModel,
      seed: 'bnarrow',
    })
    const byId = new Map(narrowB.questions.map((question) => [question.id, question]))
    const bIds = result.questionIds.filter(
      (questionId) => byId.get(questionId)?.layer === 'cooperation_behavior',
    )
    expect(bIds).toHaveLength(2)
  })

  it('fails loudly when the declared remainder cannot be filled from the pool', () => {
    const brokenB = {
      ...fixturePack,
      assessmentPolicy: {
        ...fixturePack.assessmentPolicy,
        quota: { theory_value: 4, cooperation_behavior: 4, skill_role: 1 },
        totalQuestions: 9,
        subQuota: {
          ...fixturePack.assessmentPolicy.subQuota!,
          cooperation_behavior: {
            minimumPerDimension: 1,
            remaining: 2,
            strategy: 'balanced_random' as const,
          },
        },
      },
      questions: fixturePack.questions.filter(
        (question) =>
          question.layer !== 'cooperation_behavior' ||
          question.id === 'B1Q1' ||
          question.id === 'B2Q1',
      ),
    }
    expect(() =>
      sampleQuestionSet({ pack: brokenB, scoring: fixtureScoringModel, seed: 'bfail' }),
    ).toThrow(/层余量需要 2 题，但维度 .* 已无剩余题目可补/)
  })
})

describe('option shuffle (Engineering Bible §10 last stage, §12)', () => {
  it('is deterministic for a given seed and question', () => {
    const ids = ['A001', 'B001', 'C001']
    const a = shuffleOptions(pack, ids, 'shuffle-seed')
    const b = shuffleOptions(pack, ids, 'shuffle-seed')
    expect(a).toEqual(b)
  })

  it('returns every option exactly once, so scoring by option id cannot break', () => {
    const ids = Array.from({ length: 30 }, (_, index) => pack.questions[index]?.id ?? '').filter(
      Boolean,
    )
    const shuffled = shuffleOptions(pack, ids, 'shuffle-all')
    const byId = new Map(pack.questions.map((question) => [question.id, question]))
    for (const entry of shuffled) {
      const question = byId.get(entry.questionId)
      expect(question).toBeDefined()
      expect([...entry.optionIds].sort()).toEqual(
        question?.options.map((option) => option.id).sort(),
      )
    }
  })

  it('actually reorders options for the pack', () => {
    const ids = pack.questions.slice(0, 40).map((question) => question.id)
    const shuffled = shuffleOptions(pack, ids, 'shuffle-reorder')
    const byId = new Map(pack.questions.map((question) => [question.id, question]))
    const changed = shuffled.filter((entry) => {
      const original = byId.get(entry.questionId)?.options.map((option) => option.id) ?? []
      return entry.optionIds.join(',') !== original.join(',')
    })
    expect(changed.length).toBeGreaterThan(0)
  })

  it('throws for a question that is not in the pack', () => {
    expect(() => shuffleOptions(pack, ['NOT_A_QUESTION'], 'x')).toThrow(SamplerError)
  })
})
