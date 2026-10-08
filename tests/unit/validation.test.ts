import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  REQUIRED_FORBIDDEN_LANGUAGE,
  validateQuestionPack,
  type Finding,
} from '../../src/domain/validation.ts'
import { sampleQuestionSet } from '../../src/engine/sampler.ts'
import {
  questionPackSchema,
  scoringModelSchema,
  type QuestionPack,
  type ScoringModel,
} from '../../src/domain/schemas.ts'
import { fixturePack, fixtureRoleModel, fixtureScoringModel } from '../fixtures/packs.ts'

const bundle = loadContentBundle()
const { pack, scoring, roleModel } = bundle

function run(
  overrides: {
    pack?: QuestionPack
    scoring?: ScoringModel
    roleModel?: typeof roleModel
  } = {},
) {
  const activePack = overrides.pack ?? pack
  const activeScoring = overrides.scoring ?? scoring
  /**
   * A tampered pack is often *unsamplable as well as invalid* — an unknown dimension or a pool
   * smaller than the quota makes the sampler refuse. The validator must still tell the author
   * what is wrong, so a sampler refusal is converted into an explicit finding rather than being
   * allowed to blow the report up. The runtime keeps its own loud failure (see sampler.test.ts).
   */
  let stages: ReturnType<typeof sampleQuestionSet>['stages'] = []
  try {
    stages = sampleQuestionSet({
      pack: activePack,
      scoring: activeScoring,
      seed: 'validation-test',
    }).stages
  } catch (error) {
    return validateQuestionPack({
      pack: activePack,
      scoring: activeScoring,
      roleModel: overrides.roleModel ?? roleModel,
      samplerStages: [
        {
          stage: 'seeded_sampling',
          active: false,
          reason: `抽题在题库校验阶段即失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    })
  }
  return validateQuestionPack({
    pack: activePack,
    scoring: activeScoring,
    roleModel: overrides.roleModel ?? roleModel,
    samplerStages: stages,
  })
}

function errors(report: ReturnType<typeof run>): Finding[] {
  return report.findings.filter((finding) => finding.severity === 'error')
}

function codeOf(report: ReturnType<typeof run>, code: string): Finding | undefined {
  return report.findings.find((finding) => finding.code === code)
}

describe('validation — the active bank (Engineering Bible §51)', () => {
  const report = run()
  const allDimensions =
    Object.keys(scoring.layerA.dimensions).length +
    Object.keys(scoring.layerB.dimensions).length +
    Object.keys(scoring.layerC.dimensions).length

  it('passes with zero errors', () => {
    expect(errors(report).map((finding) => `${finding.code}: ${finding.message}`)).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('counts 120 questions and reports every dimension', () => {
    expect(report.counts.questions).toBe(120)
    expect(report.dimensions).toHaveLength(allDimensions)
    expect(report.dimensions.reduce((sum, dimension) => sum + dimension.bankCount, 0)).toBe(120)
  })

  it('marks only the structurally inapplicable checks as inactive', () => {
    const inactive = report.findings.filter((finding) => finding.severity === 'inactive')
    // A-layer V1.1 activates the difficulty and family stages (its A layer has three difficulty
    // levels and shares families across sub-topics). What remains inapplicable: reverse items
    // (none in the bank) and the sampler-stage summary itself, which is inactive when any stage is.
    expect(inactive.map((finding) => finding.code).sort()).toEqual([
      'reverse_items',
      'sampler_stages',
    ])
  })

  it('surfaces the known measurement limits of the bank as warnings, not as silence', () => {
    expect(codeOf(report, 'transparent_single_key')?.severity).toBe('warning')
    expect(codeOf(report, 'unreachable_score_floor')?.severity).toBe('warning')
    expect(codeOf(report, 'truncated_stem')?.severity).toBe('warning')
    expect(codeOf(report, 'forbidden_language_list_gap')?.severity).toBe('warning')
    // The A-layer replacement removed V1.0's two negative-stem items (A011/A059), so that warning
    // legitimately no longer fires. It must still exist as a check, or its absence would be silence.
    expect(codeOf(report, 'negative_stem_without_reverse_flag')).toBeDefined()
    expect(codeOf(report, 'key_position_tell')).toBeDefined()
  })

  it('reports the key-position distribution over scored questions only', () => {
    const tell = codeOf(report, 'key_position_tell')
    expect(tell?.message).toContain('计分题')
    // A-layer V1.1's knowledge items were hand-balanced, so the overall spread improves; the check
    // must still measure it rather than assume.
    expect(tell?.message).toMatch(/[A-D]=\d+/)
  })

  it('reports the A-layer V1.1 structural rules as passing checks, not absences', () => {
    for (const code of [
      'a_layer_quota_shape',
      'a0_self_report_only',
      'a1_answer_position_balance',
      'option_order_policy_respected',
      'stale_a_consistency_groups_removed',
      'a_layer_boundary_text',
      'a_layer_scoring_policy_consistency',
      'descriptive_items_not_scored',
    ]) {
      expect(codeOf(report, code), code).toBeDefined()
      expect(codeOf(report, code)?.severity, code).toBe('pass')
    }
  })

  it('records the forbidden-language gap between code and the frozen content file', () => {
    const gap = codeOf(report, 'forbidden_language_list_gap')
    expect(gap?.severity).toBe('warning')
    expect(gap?.subjects).toContain('危险人物')
    expect(REQUIRED_FORBIDDEN_LANGUAGE).toContain('撒谎概率')
  })

  it('is stable: two runs produce identical findings', () => {
    expect(JSON.stringify(run().findings)).toBe(JSON.stringify(run().findings))
  })
})

describe('validation — tampered packs produce specific error codes', () => {
  it('duplicate_question_id', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: [...pack.questions, pack.questions[0]],
    })
    expect(errors(run({ pack: tampered })).map((finding) => finding.code)).toContain(
      'duplicate_question_id',
    )
  })

  it('unknown_dimension', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: pack.questions.map((question) =>
        question.id === 'A001' ? { ...question, dimension: 'ghost_dimension' } : question,
      ),
    })
    const codes = errors(run({ pack: tampered })).map((finding) => finding.code)
    expect(codes).toContain('unknown_dimension')
    expect(codes).toContain('dimension_layer_mismatch')
  })

  it('illegal_scoring_key', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: pack.questions.map((question) =>
        question.id === 'A001'
          ? {
              ...question,
              options: question.options.map((option) => ({ ...option, scoring: { ghost: 1 } })),
            }
          : question,
      ),
    })
    const codes = errors(run({ pack: tampered })).map((finding) => finding.code)
    expect(codes).toContain('illegal_scoring_key')
    expect(codes).toContain('scoring_key_not_matching_own_dimension')
  })

  it('illegal_role_signal_key and role_signal_on_theory_layer', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: pack.questions.map((question) =>
        question.id === 'A001'
          ? {
              ...question,
              options: question.options.map((option) => ({
                ...option,
                roleSignals: { not_a_role: 2 },
              })),
            }
          : question,
      ),
    })
    const codes = errors(run({ pack: tampered })).map((finding) => finding.code)
    expect(codes).toContain('illegal_role_signal_key')
    expect(codes).toContain('role_signal_on_theory_layer')
  })

  it('degenerate_score_spread for an item where every option scores the same', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: pack.questions.map((question) =>
        question.id === 'B001'
          ? {
              ...question,
              options: question.options.map((option) => ({
                ...option,
                scoring: { responsibility: 2 },
              })),
            }
          : question,
      ),
    })
    expect(errors(run({ pack: tampered })).map((finding) => finding.code)).toContain(
      'degenerate_score_spread',
    )
  })

  it('layer_insufficient and dimension_insufficient when the pool is too small', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: pack.questions.filter((question) => question.layer !== 'skill_role'),
    })
    const codes = errors(run({ pack: tampered })).map((finding) => finding.code)
    // The sampler cannot even run, so validateQuestionPack must still report the shortage.
    expect(codes).toContain('layer_insufficient')
  })

  it('option_missing_scoring', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      questions: pack.questions.map((question) =>
        question.id === 'B002'
          ? { ...question, options: question.options.map(({ scoring: _drop, ...rest }) => rest) }
          : question,
      ),
    })
    expect(errors(run({ pack: tampered })).map((finding) => finding.code)).toContain(
      'option_missing_scoring',
    )
  })

  it('consistency_group_reference for a group pointing at a missing question', () => {
    const tamperedScoring = scoringModelSchema.parse({
      ...scoring,
      confidence: {
        ...scoring.confidence,
        consistencyGroups: [
          ...scoring.confidence.consistencyGroups,
          {
            id: 'CG99',
            questions: ['GHOST_A', 'GHOST_B'],
            type: 'directional_alignment',
            note: 'ghost',
          },
        ],
      },
    })
    expect(errors(run({ scoring: tamperedScoring })).map((finding) => finding.code)).toContain(
      'consistency_group_reference',
    )
  })

  it('quota_total when the layer quotas do not add up to totalQuestions', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      assessmentPolicy: { ...pack.assessmentPolicy, totalQuestions: 31 },
    })
    expect(errors(run({ pack: tampered })).map((finding) => finding.code)).toContain('quota_total')
  })

  it('option_shuffle_enabled when the pack switches shuffling off', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      assessmentPolicy: {
        ...pack.assessmentPolicy,
        sampling: { ...pack.assessmentPolicy.sampling!, optionShuffle: false },
      },
    })
    expect(errors(run({ pack: tampered })).map((finding) => finding.code)).toContain(
      'option_shuffle_enabled',
    )
  })

  it('subquota_totals when a layer sub-quota contradicts the layer quota', () => {
    const tampered = questionPackSchema.parse({
      ...pack,
      assessmentPolicy: {
        ...pack.assessmentPolicy,
        subQuota: {
          ...pack.assessmentPolicy.subQuota!,
          theory_value: {
            conceptual_understanding: 4,
            theory_reality: 4,
            organizational_judgment: 4,
            reflexive_judgment: 4,
          },
        },
      },
    })
    expect(errors(run({ pack: tampered })).map((finding) => finding.code)).toContain(
      'subquota_totals',
    )
  })
})

describe('validation — fixture with a real family conflict', () => {
  it('reports family_conflict as an error when more than three items share a family', () => {
    const report = validateQuestionPack({
      pack: fixturePack,
      scoring: fixtureScoringModel,
      roleModel: fixtureRoleModel,
      samplerStages: [],
    })
    const family = report.findings.find((finding) => finding.code === 'family_conflict')
    expect(family?.severity).toBe('pass')
  })

  it('activates the difficulty stage when the fixture has two levels', () => {
    const report = validateQuestionPack({
      pack: fixturePack,
      scoring: fixtureScoringModel,
      roleModel: fixtureRoleModel,
      samplerStages: [],
    })
    expect(report.findings.find((finding) => finding.code === 'difficulty_balance')?.severity).toBe(
      'pass',
    )
    expect(report.findings.find((finding) => finding.code === 'reverse_items')?.severity).toBe(
      'pass',
    )
  })

  it('never throws, even for a pack it cannot sample', () => {
    const empty = questionPackSchema.parse({
      ...pack,
      questions: [],
      assessmentPolicy: {
        ...pack.assessmentPolicy,
        totalQuestions: 1,
        quota: { theory_value: 1, cooperation_behavior: 0, skill_role: 0 },
      },
    })
    const report = validateQuestionPack({
      pack: empty,
      scoring,
      roleModel,
      samplerStages: [],
    })
    expect(report.ok).toBe(false)
    expect(errors(report).length).toBeGreaterThan(0)
  })
})
