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
 * How a question's options may be reordered at render time (A-layer V1.1,
 * `metadata.optionOrderPolicy`).
 *
 *   fixed               — never reorder. Used where the option list *is* the information.
 *   shuffle             — free shuffle is safe (knowledge items).
 *   preserve_or_reverse — the options carry a semantic progression, so only the whole order or its
 *                         whole reverse is allowed; never an arbitrary permutation.
 *
 * Absent means `shuffle`, which is the V1.0 behaviour, so older packs keep working unchanged.
 */
export const OPTION_ORDER_POLICIES = ['fixed', 'shuffle', 'preserve_or_reverse'] as const
export const optionOrderPolicySchema = z.enum(OPTION_ORDER_POLICIES)
export type OptionOrderPolicy = z.infer<typeof optionOrderPolicySchema>

/**
 * How a question's option signals are meant to be read (A-layer V1.1, `scoringMode`).
 *
 *   knowledge_accuracy — one option is correct; the signal is correctness.
 *   profile_signal     — no correct answer; the signal is a position on an axis, and an *empty*
 *                        `scoring` map means "this item contributes no numeric score at all"
 *                        (A0 direct self-report; A2-A5 descriptive evidence).
 *
 * Absent means the V1.0 behaviour: one scored dimension with a single best option.
 */
export const SCORING_MODES = ['knowledge_accuracy', 'profile_signal'] as const
export const scoringModeSchema = z.enum(SCORING_MODES)
export type ScoringMode = z.infer<typeof scoringModeSchema>

/**
 * 0-3 signal scale per option (README "Scoring": `normalized = round(sum(score) /
 * max_possible_for_answered_items * 100)`).
 */
export const signalValueSchema = z.number().int().min(0).max(3)

/** A2-A5 exploratory axis signal: a position, not a correctness mark. */
export const profileSignalValueSchema = z.number().int().min(-2).max(2)

export const questionOptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    /**
     * dimensionId -> 0..3 signal. Keyed by dimension, never by option position.
     *
     * An **empty** map is meaningful, not missing: it marks an option that contributes no numeric
     * score. The engine must not invent a score for it.
     */
    scoring: z.record(z.string(), signalValueSchema).optional(),
    /** roleId -> 0..3 secondary signal (Engineering Bible §7, README C layer). */
    roleSignals: z.record(z.string(), signalValueSchema).optional(),
    /**
     * A0 only: which declared-identity category this option represents. Rendered verbatim as the
     * respondent's own statement; never converted into a score and never inferred from elsewhere.
     */
    selfReportCategory: z.string().min(1).optional(),
    /**
     * A2-A5: axisId -> −2..2 position signal. Exploratory calibration material, NOT a correctness
     * score, and not user-facing by default (a-scoring-model-v1.1
     * `exploratorySignals.userFacingByDefault: false`).
     */
    profileSignals: z.record(z.string(), profileSignalValueSchema).optional(),
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

    /** A-layer V1.1. Absent means V1.0 single-best-option scoring. */
    scoringMode: scoringModeSchema.optional(),

    options: z.array(questionOptionSchema).min(2),

    /** Inert author annotation (e.g. `signal`, `consistencyGroups`, `optionOrderPolicy`). */
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
        /**
         * V1.0 wrote a boolean here. V1.1 writes `"per_question_policy"`, because from V1.1 the
         * A-layer mixes question types whose options must NOT all be shuffled the same way (A0
         * fixed, A1 free, A2/A3 order-sensitive). Both forms are accepted; the per-question
         * `metadata.optionOrderPolicy` is authoritative whenever it is present.
         */
        optionShuffle: z.union([z.boolean(), z.string().min(1)]),
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
    /**
     * V1.0 wrote an object (`{validatedPsychometricInstrument, notes}`); V1.1 writes a plain array
     * of statements. Both are accepted, and the V1.1 form is treated as "not a validated
     * psychometric instrument" because that is exactly what its statements say — the A layer is
     * described as a voluntary profile, not a normed instrument.
     */
    measurementNotice: z
      .union([
        z
          .object({
            validatedPsychometricInstrument: z.boolean(),
            notes: z.array(z.string()),
          })
          .passthrough(),
        z.array(z.string()),
      ])
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

/**
 * A-layer display policy (A-layer V1.1, `scoring-v1.1.layerAProfilePolicy` and the standalone
 * `a-scoring-model-v1.1.json`).
 *
 * This is what stops the A layer from being read as a scoreboard: each dimension declares how it
 * may be shown, and `forbiddenOutputs` names what may never be produced from it.
 */
export const aDisplayPolicies = [
  'categorical_self_report',
  'knowledge_familiarity_0_100_with_low_sample_notice',
  'knowledge_familiarity_low_sample',
  'issue_position_cards',
  'practice_pattern_cards',
  'qualitative_summary_plus_evidence',
  'qualitative_summary_with_evidence',
] as const

export const aDisplayPolicySchema = z.enum(aDisplayPolicies)
export type ADisplayPolicy = z.infer<typeof aDisplayPolicySchema>

export const aLayerProfilePolicySchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    principles: z.array(z.string()),
    displayPolicy: z.record(z.string(), aDisplayPolicySchema),
    exploratorySignals: z
      .object({
        enabled: z.boolean(),
        userFacingByDefault: z.boolean(),
        purpose: z.string(),
        minimumEvidenceItemsPerSameAxis: z.number().int().nonnegative(),
      })
      .strict(),
    reporting: z.record(z.string(), z.string()),
    forbiddenOutputs: z.array(z.string()),
  })
  .strict()

export type ALayerProfilePolicy = z.infer<typeof aLayerProfilePolicySchema>

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
        /** A-layer V1.1. `false` means no A-layer total may ever be produced. */
        aggregateTotalScore: z.boolean().optional(),
        displayPolicy: z.record(z.string(), aDisplayPolicySchema).optional(),
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
    /** A-layer V1.1. Optional so a V1.0 scoring model still validates. */
    layerAProfilePolicy: aLayerProfilePolicySchema.optional(),
  })
  .strict()

export type ScoringModel = z.infer<typeof scoringModelSchema>

/**
 * Standalone A-layer policy document (`a-scoring-model-v1.1.json`). Kept as its own file because
 * the A-layer measurement model is expected to be revised on its own cadence, independently of the
 * full scoring model.
 */
export const aScoringModelSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    principles: z.array(z.string()),
    displayPolicy: z.record(z.string(), aDisplayPolicySchema),
    exploratorySignals: z
      .object({
        enabled: z.boolean(),
        userFacingByDefault: z.boolean(),
        purpose: z.string(),
        minimumEvidenceItemsPerSameAxis: z.number().int().nonnegative(),
      })
      .strict(),
    reporting: z.record(z.string(), z.string()),
    forbiddenOutputs: z.array(z.string()),
  })
  .strict()

export type AScoringModel = z.infer<typeof aScoringModelSchema>

/** A-layer result shape (`a-result-schema-v1.1.json`), used to assert what may NOT be produced. */
export const aResultSchemaDocSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    shape: z.record(z.string(), z.unknown()),
    mustNotContain: z.array(z.string()),
  })
  .strict()

export type AResultSchemaDoc = z.infer<typeof aResultSchemaDocSchema>

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

    /**
     * 提交到审阅台的幂等键。生成一次之后就固定在这个会话里，重试、刷新、关掉再打开都用同一个。
     *
     * 没有它，一次"服务端写好了但响应没回来"的网络抖动会让审阅台收到两份一模一样的材料——
     * 而审阅人无法判断那到底是两个人还是一次重试。
     */
    clientSubmissionId: z.string().min(1).optional(),
    /** 服务端返回的提交 id。存在这里，所以刷新页面不会让作答者怀疑"我到底交上了没有"。 */
    submittedId: z.string().min(1).optional(),
    submittedAt: z.string().min(1).optional(),

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
    /**
     * How many answered items actually carried a numeric signal. Lower than `answeredItems` for a
     * descriptive dimension and zero for A0 — which is why the two counts stay separate instead of
     * one number silently implying the other.
     */
    scoredItems: z.number().int().nonnegative().optional(),
    /**
     * What kind of value, if any, this dimension may show.
     *
     *   numeric     — a V1.0-style scored dimension.
     *   knowledge   — correct/answered against a known answer key; low-sample here.
     *   categorical — A0 direct self-report: no number exists, and none may be invented.
     *   descriptive — A2-A5 positions and patterns: evidence cards, not scores.
     */
    scoringKind: z.enum(['numeric', 'knowledge', 'categorical', 'descriptive']).optional(),
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

// ---------------------------------------------------------------------------
// A-layer profile (A-layer V1.1)
// ---------------------------------------------------------------------------

/**
 * A0 — the respondent's own self-description, reproduced verbatim.
 *
 * This is the one A-layer output that is not a measurement at all: it is what the person said about
 * themselves. `a-scoring-model-v1.1` principle 1 forbids inferring it from A1-A5, and the A-layer
 * result schema calls it `categorical_evidence`, so there is deliberately no score field here.
 */
export const declaredIdentityItemSchema = z
  .object({
    questionId: z.string().min(1),
    topic: z.string(),
    selectedCategory: z.string().min(1),
    selectedText: z.string().min(1),
  })
  .strict()

export type DeclaredIdentityItem = z.infer<typeof declaredIdentityItemSchema>

/** A1 — theory familiarity. A knowledge score, capped by an explicit low-sample notice. */
export const theoryFamiliaritySchema = z
  .object({
    correct: z.number().int().nonnegative(),
    answered: z.number().int().nonnegative(),
    normalizedScore: z.number().min(0).max(100),
    band: z.string(),
    lowSample: z.boolean(),
    note: z.string(),
    evidenceQuestionIds: z.array(z.string()),
  })
  .strict()

export type TheoryFamiliarity = z.infer<typeof theoryFamiliaritySchema>

/** A2-A4 — issue positions and practice patterns, shown as evidence cards rather than scores. */
export const issuePositionCardSchema = z
  .object({
    questionId: z.string().min(1),
    topic: z.string(),
    prompt: z.string(),
    selectedText: z.string().min(1),
  })
  .strict()

export type IssuePositionCard = z.infer<typeof issuePositionCardSchema>

/** A5 — a reflexivity summary that may only speak when its two items agree. */
export const reflexivitySummarySchema = z
  .object({
    state: z.enum(['aligned', 'mixed', 'insufficient']),
    summary: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceQuestionIds: z.array(z.string()),
  })
  .strict()

export type ReflexivitySummary = z.infer<typeof reflexivitySummarySchema>

export const aLayerProfileSchema = z
  .object({
    /** Which display policy each dimension was rendered under, for auditability. */
    displayPolicy: z.record(z.string(), z.string()),
    declaredIdentity: z.array(declaredIdentityItemSchema),
    theoryFamiliarity: theoryFamiliaritySchema.nullable(),
    politicalEconomy: z.array(issuePositionCardSchema),
    socialPolitical: z.array(issuePositionCardSchema),
    practiceOrientation: z.array(issuePositionCardSchema),
    reflexivity: reflexivitySummarySchema,
    /**
     * Always present and always these statements. The A layer cannot be summed, and this is where
     * the result says so about itself instead of relying on the UI to remember.
     */
    boundaries: z.array(z.string()),
  })
  .strict()

export type ALayerProfile = z.infer<typeof aLayerProfileSchema>

/**
 * The six A-layer V1.1 dimensions, in the order they are presented.
 *
 * Declared here rather than in the engine because the same list decides three things that must not
 * drift apart: which dimensions are drawn, in what order they are displayed, and which ones the
 * role-fit engine must never see.
 */
export const A_LAYER_DIMENSIONS = {
  a0: 'A0_declared_identity',
  a1: 'A1_theory_structure',
  a2: 'A2_political_economy',
  a3: 'A3_social_political',
  a4: 'A4_practice_orientation',
  a5: 'A5_reflexivity',
} as const

/**
 * Statements the A layer makes about itself, carried inside every A-layer result.
 *
 * They live in the result rather than only in the UI so that an exported JSON, a printed page, or
 * a future consumer inherits the boundary instead of depending on someone remembering it.
 */
export const A_LAYER_BOUNDARIES = [
  '本部分是自愿的政治—理论画像，不是政治可靠性、忠诚度或意识形态纯度测试。',
  '自我认同（A0）只来自答题者本人的直接自报，系统不从其他回答推断。',
  'A 层六个部分不能相加成一个综合政治分数，系统不生成任何此类总分。',
  'A 层不参与角色适配，也不用于自动吸纳或淘汰。',
  'A2–A5 以原始议题立场与实践模式为主，不把稀疏样本压成精确多轴分数。',
] as const

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
     * A-layer V1.1 six-part profile. Absent for a V1.0 result, which had four score dimensions
     * instead. Kept separate from `dimensions` because the A layer is not a score vector and must
     * not be rendered as one: A0 has no number at all, A2-A4 are evidence cards, and A5 may only
     * speak when its items agree.
     */
    aLayerProfile: aLayerProfileSchema.optional(),
    /**
     * Which Engineering Bible §10 sampler stages actually did anything under the loaded
     * question pack. Reported instead of pretending a no-op stage ran.
     */
    samplerStages: z.array(engineStageStatusSchema),
    limitations: z.array(z.string()),
  })
  .strict()

export type AssessmentResult = z.infer<typeof assessmentResultSchema>
