import { z } from 'zod'

/**
 * CohortLens domain schemas.
 *
 * Engineering Bible §7 (Question Schema), §8 (Question Pack), §15 (Dimension Score),
 * §18 (Consistency Engine), §19/§20 (Role Model), §21 (Structured Result).
 *
 * ADR-005 records the two deliberate widenings applied to the Engineering Bible schema so
 * that the frozen Question Bank V1.0 loads unchanged:
 *   1. `QuestionPack.assessmentPolicy` is a superset: it additionally carries the per-layer
 *      `subQuota` and the `sampling` flags written by the bank author. These fields carry the
 *      "5:3:2 is an information budget, not a weighted total" rule, so they live in the schema
 *      rather than being dropped.
 *   2. `Question.scenarioType` keeps all five values from the Bible, but only `concept`,
 *      `scenario` and `skill` are used by bank V1.0. No value is mandatory.
 */

export const LAYERS = ['theory_value', 'cooperation_behavior', 'skill_role'] as const
export const layerSchema = z.enum(LAYERS)
export type Layer = z.infer<typeof layerSchema>

export const SCENARIO_TYPES = ['concept', 'judgment', 'scenario', 'self_report', 'skill'] as const
export const scenarioTypeSchema = z.enum(SCENARIO_TYPES)
export type ScenarioType = z.infer<typeof scenarioTypeSchema>

/**
 * 0-3 signal scale per option (README "Scoring": `normalized = round(sum(score) /
 * max_possible_for_answered_items * 100)`).
 */
export const signalValueSchema = z.number().int().min(0).max(3)

export const questionOptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    /** dimensionId -> 0..3 signal. Keyed by dimension, never by option position. */
    scoring: z.record(z.string(), signalValueSchema).optional(),
    /** roleId -> 0..3 secondary signal (Engineering Bible §7, README C layer). */
    roleSignals: z.record(z.string(), signalValueSchema).optional(),
    /** Free-form author notes. Never interpreted by the engine. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const questionSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),

    layer: layerSchema,
    dimension: z.string().min(1),
    subDimension: z.string().min(1),

    title: z.string().min(1).optional(),
    prompt: z.string().min(1),

    scenarioType: scenarioTypeSchema,
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),

    tags: z.array(z.string()),
    reverse: z.boolean().optional(),
    familyId: z.string().min(1).optional(),

    options: z.array(questionOptionSchema).min(2),

    /** Inert author annotation (e.g. `signal`, `consistencyGroups`). Never drives scoring. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type Question = z.infer<typeof questionSchema>
export type QuestionOption = z.infer<typeof questionOptionSchema>

export const assessmentPolicySchema = z
  .object({
    totalQuestions: z.number().int().positive(),
    quota: z.record(layerSchema, z.number().int().nonnegative()),
    subQuota: z
      .object({
        theory_value: z.record(z.string(), z.number().int().nonnegative()),
        cooperation_behavior: z
          .object({
            minimumPerDimension: z.number().int().nonnegative(),
            remaining: z.number().int().nonnegative(),
            strategy: z.literal('balanced_random'),
          })
          .passthrough(),
        skill_role: z
          .object({
            exactlyPerDimension: z.number().int().nonnegative(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    sampling: z
      .object({
        seeded: z.boolean(),
        avoidDuplicateQuestion: z.boolean(),
        avoidSameFamily: z.boolean(),
        optionShuffle: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type AssessmentPolicy = z.infer<typeof assessmentPolicySchema>

export const questionPackSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    schemaVersion: z.string().min(1),
    language: z.string().min(1),
    description: z.string().min(1),
    createdAt: z.string().min(1),
    assessmentPolicy: assessmentPolicySchema,
    questions: z.array(questionSchema),
    measurementNotice: z
      .object({
        validatedPsychometricInstrument: z.boolean(),
        notes: z.array(z.string()),
      })
      .passthrough()
      .optional(),
  })
  .strict()

export type QuestionPack = z.infer<typeof questionPackSchema>

// ---------------------------------------------------------------------------
// Scoring model (scoring-model-v1.0.json)
// ---------------------------------------------------------------------------

export const interpretationBandSchema = z
  .object({
    min: z.number().int().min(0),
    max: z.number().int().max(100),
    label: z.string().min(1),
  })
  .strict()

export const consistencyGroupSchema = z
  .object({
    id: z.string().min(1),
    questions: z.array(z.string().min(1)).min(2),
    type: z.enum(['directional_alignment', 'complementary']),
    note: z.string(),
  })
  .strict()

export type ConsistencyGroup = z.infer<typeof consistencyGroupSchema>

const dimensionMapSchema = z.record(z.string(), z.string())

export const scoringModelSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    scale: z
      .object({
        min: z.number().int(),
        maxPerQuestion: z.number().int().positive(),
        normalizedMin: z.number().int(),
        normalizedMax: z.number().int(),
      })
      .strict(),
    layerA: z
      .object({
        name: z.string(),
        dimensions: dimensionMapSchema,
        useInRoleFit: z.boolean(),
        useForAdmissionDecision: z.boolean(),
      })
      .strict(),
    layerB: z.object({ name: z.string(), dimensions: dimensionMapSchema }).strict(),
    layerC: z.object({ name: z.string(), dimensions: dimensionMapSchema }).strict(),
    normalization: z.string(),
    confidence: z
      .object({
        base: z.string(),
        consistencyGroups: z.array(consistencyGroupSchema),
        rule: z.string(),
      })
      .strict(),
    interpretationBands: z.array(interpretationBandSchema).min(1),
    warnings: z.array(z.string()),
  })
  .strict()

export type ScoringModel = z.infer<typeof scoringModelSchema>

// ---------------------------------------------------------------------------
// Role model (role-model-v1.0.json)
// ---------------------------------------------------------------------------

export const roleDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * Engineering Bible §20 calls these `dimensionWeights` / `skillWeights`.
     * Bank V1.0 emits a single flat `weights` map, and every key in it is either a
     * layer-B behaviour dimension or a layer-C skill dimension, so the flat form is
     * accepted and the Bible's split form is accepted too.
     */
    weights: z.record(z.string(), z.number().nonnegative()).optional(),
    dimensionWeights: z.record(z.string(), z.number().nonnegative()).optional(),
    skillWeights: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .strict()

export const roleModelSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    rule: z.string(),
    roles: z.array(roleDefinitionSchema).min(1),
    roleSignalPolicy: z.string().optional(),
    outputLanguage: z.array(z.string()).optional(),
    forbiddenLanguage: z.array(z.string()).optional(),
  })
  .strict()

export type RoleModel = z.infer<typeof roleModelSchema>
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>

/** Flat weight map for a role, whichever of the three accepted shapes the author used. */
export function roleWeightMap(role: RoleDefinition): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const part of [role.dimensionWeights, role.skillWeights, role.weights]) {
    if (!part) continue
    for (const [key, value] of Object.entries(part)) {
      merged[key] = (merged[key] ?? 0) + value
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Session (Engineering Bible §13) and Structured Result (§15, §18, §20, §21)
// ---------------------------------------------------------------------------

export const sessionStatusSchema = z.enum(['draft', 'completed'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const assessmentSessionSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    /** Bumped on every answer so History can order by "last touched" (§37). */
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),

    questionPackId: z.string().min(1),
    questionPackVersion: z.string().min(1),
    scoringVersion: z.string().min(1),
    roleModelVersion: z.string().min(1),

    seed: z.string().min(1),
    questionIds: z.array(z.string().min(1)),
    /**
     * questionId -> optionId. Stored by option id (never by rendered position) so that
     * option shuffling cannot corrupt a saved session.
     */
    answers: z.record(z.string(), z.string()),

    /**
     * Layer-A dimension that received one fewer item, recorded so a later session can rotate the
     * shortfall instead of fixing the same dimension forever (source README line 26).
     */
    shortDimension: z.string().min(1).nullable().optional(),

    /**
     * Where the respondent had got to, so a refresh returns them to the question they were reading
     * rather than to the first unanswered one. Engineering Bible §54 says a refresh must not lose
     * progress; losing your place is losing progress.
     */
    lastIndex: z.number().int().nonnegative().optional(),

    status: sessionStatusSchema,
    resultId: z.string().min(1).optional(),
  })
  .strict()

export type AssessmentSession = z.infer<typeof assessmentSessionSchema>

export const dimensionResultSchema = z
  .object({
    id: z.string().min(1),
    layer: layerSchema,
    label: z.string(),
    rawScore: z.number(),
    normalizedScore: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
    answeredItems: z.number().int().nonnegative(),
    expectedItems: z.number().int().nonnegative(),
    maxPossible: z.number().nonnegative(),
    band: z.string(),
    evidenceQuestionIds: z.array(z.string()),
    /**
     * Per-dimension caveats. Under bank V1.0 a layer-C dimension is measured by exactly one
     * item, so its normalised score can only take two or three values; that is reported here
     * rather than hidden behind a two-digit number.
     */
    warnings: z.array(z.string()).optional(),
  })
  .strict()

export type DimensionResult = z.infer<typeof dimensionResultSchema>

export const roleFitResultSchema = z
  .object({
    roleId: z.string().min(1),
    name: z.string().min(1),
    /** 0-100 contribution-weighted score. Not a probability, not a verdict. */
    fitScore: z.number().min(0).max(100),
    /** Share of the role's weight that actually had evidence in this session. */
    coverage: z.number().min(0).max(1),
    contributingDimensions: z.array(z.string()),
    missingDimensions: z.array(z.string()),
    phrase: z.string(),
  })
  .strict()

export type RoleFitResult = z.infer<typeof roleFitResultSchema>

export const consistencyFindingSchema = z
  .object({
    groupId: z.string(),
    type: z.enum(['directional_alignment', 'complementary']),
    note: z.string(),
    questionIds: z.array(z.string()),
    /** Language is deliberately non-accusatory (Engineering Bible §18). */
    label: z.string(),
    detail: z.string(),
    confidencePenalty: z.number().min(0).max(1),
    /** Only true when a group with `reverse` semantics actually conflicts. */
    isHardConflict: z.boolean(),
  })
  .strict()

export type ConsistencyFinding = z.infer<typeof consistencyFindingSchema>

export const consistencyResultSchema = z
  .object({
    /** "回答一致性 / 回答稳定度 / 需要进一步了解" — never a deception index. */
    answerConsistency: z.number().min(0).max(1),
    /** Answer spread: share of items answered with the maximum signal. */
    extremeRepeatRate: z.number().min(0).max(1),
    findings: z.array(consistencyFindingSchema),
    needsFurtherUnderstanding: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict()

export type ConsistencyResult = z.infer<typeof consistencyResultSchema>

export const evidenceReferenceSchema = z
  .object({
    questionId: z.string().min(1),
    dimension: z.string().min(1),
    optionId: z.string().min(1),
    signal: z.number(),
    maxSignal: z.number(),
  })
  .strict()

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>

export const engineStageStatusSchema = z
  .object({
    stage: z.string(),
    active: z.boolean(),
    reason: z.string(),
  })
  .strict()

export type EngineStageStatus = z.infer<typeof engineStageStatusSchema>

export const assessmentResultSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    generatedAt: z.string().min(1),
    versions: z
      .object({
        questionPack: z.string().min(1),
        scoring: z.string().min(1),
        roleModel: z.string().min(1),
      })
      .strict(),
    /** Profile vector. Deliberately no single total score (Engineering Bible §16). */
    dimensions: z.array(dimensionResultSchema),
    roleFits: z.array(roleFitResultSchema),
    strengths: z.array(z.string()),
    developmentAreas: z.array(z.string()),
    consistency: consistencyResultSchema,
    evidence: z.array(evidenceReferenceSchema),
    /**
     * Which Engineering Bible §10 sampler stages actually did anything under the loaded
     * question pack. Reported instead of pretending a no-op stage ran.
     */
    samplerStages: z.array(engineStageStatusSchema),
    limitations: z.array(z.string()),
  })
  .strict()

export type AssessmentResult = z.infer<typeof assessmentResultSchema>
