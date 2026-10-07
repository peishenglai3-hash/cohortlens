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

  it('splits layer A as 4 + 4 + 4 + 3 with a single short dimension', () => {
    let shortDimension: string | null = null
    for (let index = 0; index < 300; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `layerA-${index}` })
      const byId = new Map(pack.questions.map((question) => [question.id, question]))
      const counts = new Map<string, number>()
      for (const questionId of result.questionIds) {
        const question = byId.get(questionId)
        if (question?.layer !== 'theory_value') continue
        counts.set(question.dimension, (counts.get(question.dimension) ?? 0) + 1)
      }
      expect(counts.size).toBe(4)
      const values = [...counts.values()].sort((a, b) => a - b)
      expect(values).toEqual([3, 4, 4, 4])
      const short = [...counts.entries()].filter(([, count]) => count === 3).map(([id]) => id)
      expect(short).toHaveLength(1)
      shortDimension = short[0] ?? null
      expect(result.layerAShortDimension).toBe(shortDimension)
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

  it('rotates the layer-A short dimension instead of fixing it', () => {
    const shortCounts = new Map<string, number>()
    for (let index = 0; index < 400; index += 1) {
      const result = sampleQuestionSet({ pack, scoring, seed: `rotate-${index}` })
      const short = result.layerAShortDimension ?? 'none'
      shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1)
    }
    expect(shortCounts.size).toBe(4)
    for (const count of shortCounts.values()) {
      // Uniform would be 100; anything above 175 would signal a fixed bias.
      expect(count).toBeLessThan(175)
      expect(count).toBeGreaterThan(25)
    }
  })

  it('honours previousSessions by avoiding the most recent short dimension', () => {
    for (let index = 0; index < 100; index += 1) {
      const first = sampleQuestionSet({ pack, scoring, seed: `history-a-${index}` })
      const second = sampleQuestionSet({
        pack,
        scoring,
        seed: `history-b-${index}`,
        previousSessions: [
          { seed: first.layerAShortDimension ?? '', shortDimension: first.layerAShortDimension },
        ],
      })
      expect(second.layerAShortDimension).not.toBe(first.layerAShortDimension)
    }
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
    // These three are structurally inert under bank V1.0 and must say so.
    expect(byStageName.get('difficulty_balance')?.active).toBe(false)
    expect(byStageName.get('family_conflict_filtering')?.active).toBe(false)
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

  it('keeps the shipped layer-A split at 4 + 4 + 4 + 3 when declared targets are balanced', () => {
    const result = sampleQuestionSet({ pack, scoring, seed: 'balanced-plan' })
    const byId = new Map(pack.questions.map((question) => [question.id, question]))
    const perDimension = new Map<string, number>()
    for (const questionId of result.questionIds) {
      const question = byId.get(questionId)
      if (question?.layer !== 'theory_value') continue
      perDimension.set(question.dimension, (perDimension.get(question.dimension) ?? 0) + 1)
    }
    expect([...perDimension.values()].sort((a, b) => a - b)).toEqual([3, 4, 4, 4])
  })

  it('grows the plan when the declared target is below the layer quota', () => {
    const packGrow = buildTwoDimensionPack({ a_one: 1, a_two: 1 })
    const result = sampleQuestionSet({ pack: packGrow, scoring: trimmedScoring, seed: 'grow-plan' })
    expect(result.questionIds).toHaveLength(4)
    expect(new Set(result.questionIds).size).toBe(4)
    const byId = new Map(packGrow.questions.map((question) => [question.id, question]))
    const perDimension = new Map<string, number>()
    for (const questionId of result.questionIds) {
      const question = byId.get(questionId)
      if (!question) continue
      perDimension.set(question.dimension, (perDimension.get(question.dimension) ?? 0) + 1)
    }
    // The two added items are spread evenly across the two dimensions.
    expect([...perDimension.values()].sort((a, b) => a - b)).toEqual([2, 2])
  })

  it('trims the plan when the declared target exceeds the layer quota', () => {
    const packTrim = buildTwoDimensionPack({ a_one: 3, a_two: 3 })
    const result = sampleQuestionSet({ pack: packTrim, scoring: trimmedScoring, seed: 'trim-plan' })
    expect(result.questionIds).toHaveLength(4)
    const byId = new Map(packTrim.questions.map((question) => [question.id, question]))
    const perDimension = new Map<string, number>()
    for (const questionId of result.questionIds) {
      const question = byId.get(questionId)
      if (!question) continue
      perDimension.set(question.dimension, (perDimension.get(question.dimension) ?? 0) + 1)
    }
    // Trimming stays even too, so the plan is 2 + 2 rather than 1 + 3.
    expect([...perDimension.values()].sort((a, b) => a - b)).toEqual([2, 2])
    expect(result.layerAShortDimension).toBeDefined()
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
