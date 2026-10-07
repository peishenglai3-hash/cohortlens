import {
  questionPackSchema,
  roleModelSchema,
  scoringModelSchema,
  type Question,
  type QuestionPack,
  type RoleModel,
  type ScoringModel,
} from '../../src/domain/schemas.ts'

/**
 * Hand-built fixtures for engine unit tests.
 *
 * The real bank cannot express every edge case (it has no reverse items, no repeated families and
 * a single difficulty level), so the engine's branch behaviour is pinned here with fixtures whose
 * numbers are small enough to verify by hand. These fixtures are test-only and never shipped.
 */

export const FIXTURE_TIME = '2026-10-07T12:00:00.000Z'

export const fixtureScoringModel: ScoringModel = scoringModelSchema.parse({
  id: 'scoring-test',
  version: '1.0.0',
  scale: { min: 0, maxPerQuestion: 3, normalizedMin: 0, normalizedMax: 100 },
  layerA: {
    name: 'A',
    dimensions: { a_one: 'A1', a_two: 'A2' },
    useInRoleFit: false,
    useForAdmissionDecision: false,
  },
  layerB: { name: 'B', dimensions: { b_one: 'B1', b_two: 'B2' } },
  layerC: { name: 'C', dimensions: { c_one: 'C1' } },
  normalization:
    'dimension_score = round(sum(answer_score) / max_possible_for_answered_items * 100)',
  confidence: {
    base: 'answered_items / expected_items',
    consistencyGroups: [
      {
        id: 'TG01',
        questions: ['B1Q1', 'B2Q1'],
        type: 'directional_alignment',
        note: 'test alignment',
      },
      { id: 'TG02', questions: ['A1Q1', 'A2Q1'], type: 'complementary', note: 'test complement' },
    ],
    rule: 'only lower confidence',
  },
  interpretationBands: [
    { min: 0, max: 39, label: 'low' },
    { min: 40, max: 59, label: 'mid' },
    { min: 60, max: 79, label: 'high' },
    { min: 80, max: 100, label: 'top' },
  ],
  warnings: ['test fixture'],
})

export const fixtureRoleModel: RoleModel = roleModelSchema.parse({
  id: 'roles-test',
  version: '1.0.0',
  rule: 'only behaviour and skill dimensions',
  roles: [
    {
      id: 'alpha',
      name: 'Alpha',
      weights: { b_one: 1 },
    },
    {
      id: 'beta',
      name: 'Beta',
      weights: { b_two: 0.5, c_one: 0.5 },
    },
    {
      id: 'gamma',
      name: 'Gamma',
      weights: { b_one: 0.5, c_one: 0.5 },
    },
  ],
  outputLanguage: ['当前回答显示'],
  forbiddenLanguage: ['就是这种人'],
})

function option(
  questionId: string,
  letter: string,
  dimension: string,
  value: number,
): Question['options'][number] {
  return {
    id: `${questionId}_${letter}`,
    text: `${questionId} option ${letter}`,
    scoring: { [dimension]: value },
  }
}

function question(params: {
  id: string
  layer: Question['layer']
  dimension: string
  scores: [number, number, number, number]
  reverse?: boolean
  familyId?: string
  difficulty?: 1 | 2 | 3
  scenarioType?: Question['scenarioType']
  subDimensionOverride?: string
}): Question {
  const { id, layer, dimension, scores } = params
  return {
    id,
    version: 1,
    layer,
    dimension,
    subDimension: params.subDimensionOverride ?? `${dimension}_sub`,
    prompt: `${id} prompt`,
    scenarioType: params.scenarioType ?? 'concept',
    difficulty: params.difficulty ?? 2,
    tags: ['fixture'],
    reverse: params.reverse ?? false,
    familyId: params.familyId ?? `F-${id}`,
    options: [
      option(id, 'A', dimension, scores[0]),
      option(id, 'B', dimension, scores[1]),
      option(id, 'C', dimension, scores[2]),
      option(id, 'D', dimension, scores[3]),
    ],
  }
}

/**
 * A tiny but complete pack: 2 layer-A dimensions, 2 layer-B dimensions, 1 layer-C dimension, with
 * a 4 / 2 / 1 quota and two repeated families so the family-conflict stage has work to do.
 */
export const fixturePack: QuestionPack = questionPackSchema.parse({
  id: 'pack-test',
  name: 'Test Pack',
  version: '1.0.0',
  schemaVersion: '1.0',
  language: 'zh-CN',
  description: 'fixture',
  createdAt: '2026-10-07',
  assessmentPolicy: {
    totalQuestions: 7,
    quota: { theory_value: 4, cooperation_behavior: 2, skill_role: 1 },
    subQuota: {
      theory_value: { a_one: 2, a_two: 2 },
      cooperation_behavior: { minimumPerDimension: 1, remaining: 0, strategy: 'balanced_random' },
      skill_role: { exactlyPerDimension: 1 },
    },
    sampling: {
      seeded: true,
      avoidDuplicateQuestion: true,
      avoidSameFamily: true,
      optionShuffle: true,
    },
  },
  questions: [
    // layer A: a_one x3 (two of them share a family, so the family filter has real work to do),
    // a_two x3 with unique families so a replacement always exists.
    question({
      id: 'A1Q1',
      layer: 'theory_value',
      dimension: 'a_one',
      scores: [0, 1, 2, 3],
      familyId: 'F-A1-SHARED',
    }),
    question({
      id: 'A1Q2',
      layer: 'theory_value',
      dimension: 'a_one',
      scores: [0, 1, 1, 3],
      familyId: 'F-A1-SHARED',
    }),
    question({
      id: 'A1Q3',
      layer: 'theory_value',
      dimension: 'a_one',
      scores: [0, 1, 1, 3],
      familyId: 'F-A1-Q3',
    }),
    question({
      id: 'A2Q1',
      layer: 'theory_value',
      dimension: 'a_two',
      scores: [0, 1, 1, 3],
      familyId: 'F-A2-Q1',
    }),
    question({
      id: 'A2Q2',
      layer: 'theory_value',
      dimension: 'a_two',
      scores: [0, 0, 1, 3],
      familyId: 'F-A2-Q2',
    }),
    question({
      id: 'A2Q3',
      layer: 'theory_value',
      dimension: 'a_two',
      scores: [0, 1, 1, 3],
      familyId: 'F-A2-Q3',
    }),
    // layer B
    question({
      id: 'B1Q1',
      layer: 'cooperation_behavior',
      dimension: 'b_one',
      scores: [0, 1, 1, 3],
      scenarioType: 'scenario',
    }),
    question({
      id: 'B1Q2',
      layer: 'cooperation_behavior',
      dimension: 'b_one',
      scores: [0, 1, 1, 3],
      scenarioType: 'scenario',
    }),
    question({
      id: 'B2Q1',
      layer: 'cooperation_behavior',
      dimension: 'b_two',
      scores: [0, 1, 1, 3],
      scenarioType: 'self_report',
    }),
    question({
      id: 'B2Q2',
      layer: 'cooperation_behavior',
      dimension: 'b_two',
      scores: [0, 1, 1, 3],
      scenarioType: 'self_report',
    }),
    // layer C, with two difficulty levels so the difficulty stage can act
    question({
      id: 'C1Q1',
      layer: 'skill_role',
      dimension: 'c_one',
      scores: [0, 1, 1, 3],
      scenarioType: 'skill',
      difficulty: 1,
    }),
    question({
      id: 'C1Q2',
      layer: 'skill_role',
      dimension: 'c_one',
      scores: [0, 1, 2, 3],
      scenarioType: 'skill',
      difficulty: 3,
    }),
    // an optional reverse item, so the reverse branch is exercised
    question({
      id: 'C1Q3',
      layer: 'skill_role',
      dimension: 'c_one',
      scores: [3, 1, 1, 0],
      scenarioType: 'skill',
      reverse: true,
    }),
  ],
})

export const fixtureBundle = {
  pack: fixturePack,
  scoring: fixtureScoringModel,
  roleModel: fixtureRoleModel,
}

/**
 * A scoring model declaring only the two layer-A dimensions used by the trimmed packs, so the
 * sampler's plan arithmetic can be exercised against a quota that differs from the declared
 * per-dimension targets without tripping the "dimension declared but empty" guard.
 */
export const trimmedScoring: ScoringModel = scoringModelSchema.parse({
  ...fixtureScoringModel,
  layerA: {
    ...fixtureScoringModel.layerA,
    dimensions: { a_one: 'A1', a_two: 'A2' },
  },
})

function trimmedPolicy(declared: {
  a_one: number
  a_two: number
}): QuestionPack['assessmentPolicy'] {
  return {
    totalQuestions: 4,
    quota: { theory_value: 4, cooperation_behavior: 0, skill_role: 0 },
    subQuota: {
      theory_value: declared,
      cooperation_behavior: { minimumPerDimension: 0, remaining: 0, strategy: 'balanced_random' },
      skill_role: { exactlyPerDimension: 0 },
    },
    sampling: {
      seeded: true,
      avoidDuplicateQuestion: true,
      avoidSameFamily: true,
      optionShuffle: true,
    },
  }
}

/** Three items in each of the two layer-A dimensions (clones included), for the growth branch. */
export const trimmedPack: QuestionPack = questionPackSchema.parse({
  ...fixturePack,
  id: 'pack-trimmed-a',
  name: 'Trimmed A pack',
  questions: [
    ...fixturePack.questions.filter(
      (question) => question.layer === 'theory_value' && question.dimension === 'a_one',
    ),
    ...fixturePack.questions.filter(
      (question) => question.layer === 'theory_value' && question.dimension === 'a_two',
    ),
    // Clones keep the pool deep enough for a plan that needs more items per dimension than the
    // original fixture holds, without touching the production bank.
    question({
      id: 'A1X1',
      layer: 'theory_value',
      dimension: 'a_one',
      scores: [0, 1, 1, 3],
      familyId: 'F-A1X1',
      subDimensionOverride: 'a_one_clone',
    }),
    question({
      id: 'A2X1',
      layer: 'theory_value',
      dimension: 'a_two',
      scores: [0, 1, 1, 3],
      familyId: 'F-A2X1',
      subDimensionOverride: 'a_two_clone',
    }),
  ],
  assessmentPolicy: trimmedPolicy({ a_one: 1, a_two: 1 }),
})

/**
 * A pack whose declared per-dimension targets (3 + 3) exceed the layer quota (4), so the planner
 * must trim. Four items per dimension are available, matching bank V1.0's pool depth.
 */
export const trimmedWidePack: QuestionPack = questionPackSchema.parse({
  ...trimmedPack,
  id: 'pack-trimmed-wide',
  questions: [
    ...trimmedPack.questions,
    question({
      id: 'A1X2',
      layer: 'theory_value',
      dimension: 'a_one',
      scores: [0, 0, 1, 3],
      familyId: 'F-A1X2',
      subDimensionOverride: 'a_one_w2',
    }),
    question({
      id: 'A2X2',
      layer: 'theory_value',
      dimension: 'a_two',
      scores: [0, 1, 1, 3],
      familyId: 'F-A2X2',
      subDimensionOverride: 'a_two_w2',
    }),
  ],
  assessmentPolicy: trimmedPolicy({ a_one: 3, a_two: 3 }),
})
