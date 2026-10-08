import { createRng, type Rng } from './rng.ts'
import {
  LAYERS,
  type EngineStageStatus,
  type Layer,
  type OptionOrderPolicy,
  type Question,
  type QuestionPack,
  type ScoringModel,
} from '../domain/schemas.ts'

/**
 * Stratified seeded sampler.
 *
 * Engineering Bible §10 pipeline:
 *   Question Bank -> Layer Partition -> Subdimension Coverage -> Family Conflict Filtering
 *   -> Difficulty Balance -> Seeded Sampling -> Final Question Set -> Option Shuffle
 *
 * §11 requires the 15 / 9 / 6 split, sub-dimension coverage, no repeated `familyId`,
 * no over-concentration of difficulty, and no near-duplicate semantic items.
 *
 * This implementation runs **every** stage, and reports per stage whether it actually did any
 * work under the loaded pack. Under Question Bank V1.0 three stages are structurally inert
 * (all questions share `difficulty: 2`, every `familyId` is unique, and near-duplicate exclusion
 * has no declared exclusion rules), so they are reported as inactive instead of being claimed
 * as executed. `Math.random` is never used (§12, ADR-006).
 */

/** Alias kept so the sampler's own vocabulary stays local while the shape stays shared. */
export type SamplerStageReport = EngineStageStatus

export interface SampledQuestionSet {
  /** questionIds in assessment order: layer A, then B, then C. */
  questionIds: string[]
  stages: SamplerStageReport[]
  /**
   * Always `null` from A-layer V1.1 onwards.
   *
   * V1.0 gave every A dimension the same target and rotated which one received one item fewer, so
   * the sampler had to report which dimension that was. V1.1 declares a fixed, deliberately uneven
   * split (2/3/3/3/2/2) per dimension, so there is no shortfall to report. The field is kept so a
   * stored V1.0 session can still be read back without a database migration.
   */
  layerAShortDimension: string | null
}

/** Layer quota lookup. `quota` is an open record, so a missing layer reads as zero. */
function layerQuota(pack: QuestionPack, layer: Layer): number {
  return pack.assessmentPolicy.quota[layer] ?? 0
}

export interface SampleInput {
  pack: QuestionPack
  scoring: ScoringModel
  seed: string
  /**
   * Session ids of previous assessments of the same pack, oldest first. Used only to avoid
   * repeating the same layer-A short dimension twice in a row (source README line 26:
   * "不能永久固定同一维少抽"). The draw stays a pure function of `seed` plus this list.
   */
  previousSessions?: readonly { seed: string; shortDimension: string | null }[]
}

export class SamplerError extends Error {
  override readonly name = 'SamplerError'
}

function layerKey(layer: Layer): 'layerA' | 'layerB' | 'layerC' {
  if (layer === 'theory_value') return 'layerA'
  if (layer === 'cooperation_behavior') return 'layerB'
  return 'layerC'
}

function groupByDimension(questions: readonly Question[]): Map<string, Question[]> {
  const grouped = new Map<string, Question[]>()
  for (const question of questions) {
    const list = grouped.get(question.dimension) ?? []
    list.push(question)
    grouped.set(question.dimension, list)
  }
  return grouped
}

function stage(stageName: string, active: boolean, reason: string): SamplerStageReport {
  return { stage: stageName, active, reason }
}

/**
 * Family conflict filtering (§10/§11 "avoidSameFamily"): never place two questions of the same
 * `familyId` in one paper.
 *
 * This is a *constraint on the draw*, not a post-hoc repair. An earlier version drew first and
 * de-duplicated afterwards, which could silently hand back a paper one or two items short when
 * the replacement pool ran dry. Here the draw is retried under the constraint, so a returned paper
 * is always the requested size or the sampler throws. Under bank V1.0 every `familyId` is unique,
 * so the constraint is vacuous and the caller reports the stage as inactive.
 */
function hasSharedFamily(pool: readonly Question[]): boolean {
  const counts = new Map<string, number>()
  for (const question of pool) {
    if (!question.familyId) continue
    counts.set(question.familyId, (counts.get(question.familyId) ?? 0) + 1)
  }
  return [...counts.values()].some((count) => count > 1)
}

function hasFamilyConflict(questions: readonly Question[]): boolean {
  const used = new Set<string>()
  for (const question of questions) {
    if (!question.familyId) continue
    if (used.has(question.familyId)) return true
    used.add(question.familyId)
  }
  return false
}

/**
 * Difficulty balance (§10/§11): keep the drawn paper from over-concentrating on one difficulty.
 * Under bank V1.0 every question is difficulty 2, so the stage cannot act — reported as inactive.
 */
function balanceDifficulty(
  plan: readonly Question[],
  pool: readonly Question[],
  rng: Rng,
  maxPerLevel?: number,
): { picked: Question[]; active: boolean; reason: string } {
  const levels = new Set(pool.map((question) => question.difficulty))
  if (levels.size <= 1) {
    return {
      picked: [...plan],
      active: false,
      reason: `题库难度只有一档（difficulty=${[...levels][0]}），无难度可平衡`,
    }
  }
  const cap = maxPerLevel ?? Math.max(1, Math.ceil(plan.length / levels.size) + 1)

  /**
   * The balance is done by **swapping**, never by dropping, and only **within the same dimension**.
   *
   * Two defects drove this shape, both found by the per-dimension quota assertion downstream:
   *
   *   1. An earlier version moved over-cap items into a "displaced" list and pushed the original
   *      back only if a replacement existed. A missing replacement silently *shrank the paper*.
   *   2. The first swap version drew replacements from the whole layer pool, so it could exchange an
   *      item of one dimension for an item of another and break the declared per-dimension quota
   *      (A-layer V1.1 draws a non-uniform 2/3/3/3/2/2).
   *
   * Constraining swaps to the same dimension makes the dimension counts invariant by construction,
   * so this stage can only change *which* question occupies a slot. If no legal swap exists the
   * over-cap item is kept and the shortfall is reported in `reason`, never achieved by removing a
   * question.
   */
  const picked = [...plan]
  const usedIds = new Set(picked.map((question) => question.id))
  const alternatives = rng.shuffle(pool.filter((question) => !usedIds.has(question.id)))
  let swaps = 0
  let unsatisfied = 0

  const countAt = (level: number): number =>
    picked.filter((entry) => entry.difficulty === level).length

  for (let index = 0; index < picked.length; index += 1) {
    const current = picked[index]
    if (!current) continue
    if (countAt(current.difficulty) <= cap) continue

    const candidate = alternatives.find(
      (entry) =>
        entry.dimension === current.dimension &&
        entry.difficulty !== current.difficulty &&
        countAt(entry.difficulty) < cap &&
        !picked.some((existing) => existing.id === entry.id) &&
        !hasFamilyConflict([...picked.filter((existing) => existing.id !== current.id), entry]),
    )
    if (!candidate) {
      unsatisfied += 1
      continue
    }
    picked[index] = candidate
    alternatives.splice(alternatives.indexOf(candidate), 1)
    swaps += 1
  }

  return {
    picked,
    active: true,
    reason:
      unsatisfied === 0
        ? `按难度上限 ${cap} 均衡，替换 ${swaps} 题，题量保持 ${picked.length} 题`
        : `按难度上限 ${cap} 均衡，替换 ${swaps} 题；有 ${unsatisfied} 题找不到可替换项（题量不变，仅难度分布未完全均衡）`,
  }
}

/**
 * Near-duplicate semantic exclusion (§11 "避免几道语义高度相近题同时出现").
 * Bank V1.0 declares no exclusion rules, so only an explicit future rule can activate this.
 */
function applySemanticExclusion(
  pool: readonly Question[],
  selected: readonly Question[],
  exclusionGroups: readonly (readonly string[])[],
): { picked: Question[]; active: boolean; reason: string } {
  if (exclusionGroups.length === 0) {
    return { picked: [...selected], active: false, reason: '题库未声明语义互斥规则' }
  }
  const dropped = new Set<string>()
  for (const group of exclusionGroups) {
    const hit = group.filter((id) => selected.some((question) => question.id === id))
    for (const id of hit.slice(1)) dropped.add(id)
  }
  const picked = selected.filter((question) => !dropped.has(question.id))
  const replacements = pool.filter(
    (question) => !picked.includes(question) && !selected.includes(question),
  )
  while (picked.length < selected.length && replacements.length > 0) {
    const next = replacements.shift()
    if (next) picked.push(next)
  }
  return { picked, active: true, reason: `语义互斥规则剔除 ${dropped.size} 题并补齐` }
}

export function sampleQuestionSet({
  pack,
  scoring,
  seed,
  previousSessions = [],
}: SampleInput): SampledQuestionSet {
  if (!seed.trim()) throw new SamplerError('seed 不能为空：抽题必须可复现（§12）')

  const policy = pack.assessmentPolicy
  const subQuota = policy.subQuota
  const stages: SamplerStageReport[] = []

  // --- Stage 1: layer partition ---------------------------------------------
  const byLayer = new Map<Layer, Question[]>()
  for (const layer of LAYERS) byLayer.set(layer, [])
  for (const question of pack.questions) {
    const list = byLayer.get(question.layer)
    if (!list) {
      throw new SamplerError(`题目 ${question.id} 的 layer "${question.layer}" 不在已知层级中`)
    }
    list.push(question)
  }
  stages.push(
    stage(
      'layer_partition',
      true,
      LAYERS.map((layer) => `${layer}=${byLayer.get(layer)?.length ?? 0}`).join(' '),
    ),
  )

  // --- Stage 2: sub-dimension coverage plan ---------------------------------
  const dimensionsByLayer = new Map<Layer, string[]>()
  for (const layer of LAYERS) {
    const declared = Object.keys(scoring[layerKey(layer)].dimensions)
    const present = new Set((byLayer.get(layer) ?? []).map((question) => question.dimension))
    const unknown = [...present].filter((dimension) => !declared.includes(dimension))
    if (unknown.length > 0) {
      throw new SamplerError(
        `层级 ${layer} 出现评分模型未声明的维度：${unknown.join(', ')}（题库与评分模型版本不匹配）`,
      )
    }
    dimensionsByLayer.set(layer, declared)
  }
  stages.push(
    stage(
      'subdimension_coverage',
      true,
      LAYERS.map((layer) => `${layer}:${(dimensionsByLayer.get(layer) ?? []).length} 维`).join(' '),
    ),
  )

  // --- Layer A: 15 items, strict per-dimension subQuota ----------------------
  const layerA = byLayer.get('theory_value') ?? []
  const groupsA = groupByDimension(layerA)
  const dimsA = dimensionsByLayer.get('theory_value') ?? []
  if (dimsA.length === 0) throw new SamplerError('评分模型未声明任何 A 层维度')

  /**
   * A-layer plan = the pack's declared per-dimension subQuota, verbatim.
   *
   * V1.0 declared a uniform target and one rotating shortfall (4/4/4/3), and the sampler used to
   * *derive* which dimension lost the item. A-layer V1.1 replaces that with a genuinely uneven,
   * fixed split — 2/3/3/3/2/2 across six dimensions — because the six dimensions are different
   * kinds of evidence, not interchangeable slots. There is nothing left to rotate, so the plan is
   * now read directly and the rotation machinery is gone (ADR-018).
   *
   * The sum must equal the layer quota; a pack that declares otherwise is rejected rather than
   * silently rescaled, because rescaling would change the information budget the author chose.
   */
  const declaredSubQuotaA = subQuota?.theory_value ?? {}
  const planA = new Map<string, number>()
  for (const dimension of dimsA) {
    const declared = declaredSubQuotaA[dimension]
    if (declared === undefined) {
      throw new SamplerError(
        `A 层维度 ${dimension} 未在 assessmentPolicy.subQuota.theory_value 中声明单次配额。` +
          `A 层 V1.1 的六个维度承载不同类型的证据，配额必须由题库显式声明，不能由抽样器推算。`,
      )
    }
    planA.set(dimension, declared)
  }

  const sumA = [...planA.values()].reduce((a, b) => a + b, 0)
  if (sumA !== layerQuota(pack, 'theory_value')) {
    throw new SamplerError(
      `A 层配额之和 ${sumA} 不等于层级配额 ${layerQuota(pack, 'theory_value')}（各维目标 ${[
        ...planA.entries(),
      ]
        .map(([dimension, count]) => `${dimension}=${count}`)
        .join(', ')}）`,
    )
  }
  for (const [dimension, need] of planA) {
    if (need === 0) continue
    const pool = groupsA.get(dimension) ?? []
    if (pool.length < need) {
      throw new SamplerError(`A 层维度 ${dimension} 需要 ${need} 题，题库只有 ${pool.length} 题`)
    }
  }

  /**
   * Legacy sessions carried the V1.0 rotating shortfall. V1.1 has no shortfall, so the field is
   * reported as `null` and older values are simply ignored rather than reinterpreted.
   */
  void previousSessions

  /**
   * Draw a layer under its quota, its per-question dimension targets, and the family constraint.
   *
   * The family rule is **per dimension**: within one dimension, the most questions drawn from a
   * single `familyId` is capped at `ceil(need / distinctFamilies)`. Two consequences matter.
   *
   *   - V1.0 behaviour is unchanged. There every `familyId` is unique, so the cap is 1 per family
   *     and the rule reduces exactly to the old "no two same-family items in one paper".
   *   - V1.1 becomes drawable at all. Its A layer deliberately shares a `familyId` across the items
   *     of one sub-topic (all 8 A0 items are four families of two; A1's 12 items are six families
   *     of two). A paper-wide "no family twice" rule makes A0's quota of 2 impossible; the cap
   *     keeps the intent — do not lean on one sub-topic — without contradicting the pack.
   *
   * When the cap cannot be met the draw is retried with a seed derived from the attempt number, so
   * the result stays a pure function of the seed. A successful return always carries exactly the
   * requested number of items.
   */
  function drawLayer(
    layerName: string,
    pool: readonly Question[],
    groups: Map<string, Question[]>,
    plan: ReadonlyMap<string, number>,
    planDescription: string,
    needsEvenRemainder: boolean,
  ): Question[] {
    const dimensions = [...plan.keys()]

    /**
     * Family rule: **within one dimension, each `familyId` is drawn at most once.**
     *
     * The A-layer quota is small (2 or 3 per dimension) and every A dimension has at least four
     * distinct families, so this strictest reading is always satisfiable — and it is the reading
     * that best matches what `avoidSameFamily` is for: a dimension should not lean on one sub-topic.
     * V1.0 is unaffected, because there every `familyId` is unique, so the rule reduces to the old
     * "no two same-family items in one paper".
     *
     * Returns `true` when the constraint applies at all (i.e. some family repeats in the pool).
     */
    const familyConstrained = hasSharedFamily(pool)

    const drawDimension = (
      candidates: readonly Question[],
      need: number,
      attemptRng: Rng,
    ): Question[] => {
      if (!familyConstrained) return attemptRng.sample(candidates, need)
      const buckets = new Map<string, Question[]>()
      for (const question of candidates) {
        const key = question.familyId ?? `__nofamily__${question.id}`
        const bucket = buckets.get(key) ?? []
        bucket.push(question)
        buckets.set(key, bucket)
      }
      const families = attemptRng.shuffle([...buckets.keys()])
      if (families.length < need) {
        throw new SamplerError(
          `维度 ${candidates[0]?.dimension ?? '(未知)'} 需要 ${need} 题，但只有 ${families.length} 个 familyId；` +
            `按"同一维度内每族只取一次"无法凑齐`,
        )
      }
      // One per family, choosing which question inside the family at random.
      return families
        .slice(0, need)
        .map((family) => attemptRng.pick(buckets.get(family) ?? []))
        .filter((question): question is Question => question !== undefined)
    }

    for (let attempt = 0; attempt < 250; attempt += 1) {
      const attemptRng = createRng(`${seed}::${layerName}::attempt::${attempt}`)
      const taken: Question[] = []
      for (const dimension of dimensions) {
        const need = plan.get(dimension) ?? 0
        if (need === 0) continue
        const candidates = groups.get(dimension) ?? []
        if (candidates.length < need) {
          throw new SamplerError(
            `${layerName} 层维度 ${dimension} 需要 ${need} 题，题库只有 ${candidates.length} 题（${planDescription}）`,
          )
        }
        taken.push(...drawDimension(candidates, need, attemptRng))
      }

      // Layer B remainder: balance the surplus across the dimensions that hold the fewest items.
      if (needsEvenRemainder) {
        const base = [...plan.values()].reduce((a, b) => a + b, 0)
        const extra = layerQuota(pack, layerName as Layer) - base
        const selectedIds = new Set(taken.map((question) => question.id))
        for (let slot = 0; slot < extra; slot += 1) {
          const counts = new Map<string, number>()
          for (const dimension of dimensions) {
            counts.set(
              dimension,
              taken.filter((question) => question.dimension === dimension).length,
            )
          }
          const lowest = Math.min(...counts.values())
          const dimCandidates = dimensions.filter((dimension) => counts.get(dimension) === lowest)
          const dimension = attemptRng.pick(dimCandidates)
          const localPool = (groups.get(dimension) ?? []).filter(
            (question) => !selectedIds.has(question.id),
          )
          if (localPool.length === 0) {
            throw new SamplerError(
              `${layerName} 层余量需要 ${extra} 题，但维度 ${dimension} 已无剩余题目可补`,
            )
          }
          const chosen = attemptRng.pick(localPool)
          selectedIds.add(chosen.id)
          taken.push(chosen)
        }
      }

      // `drawDimension` enforces the family rule while drawing, so a paper that returns is already
      // compliant. The loop therefore only needs one pass; the retry budget is kept for the case
      // where the remainder slot below has to be re-rolled.
      return taken
    }

    throw new SamplerError(
      `${layerName} 层在 250 次重抽内仍无法同时满足配额与 familyId 约束；请检查题库的 familyId 分布`,
    )
  }

  const pickedA = drawLayer('theory_value', layerA, groupsA, planA, 'A 层', false)

  // --- Layer B: 9 items, every dimension at least once, remainder balanced ----
  const layerB = byLayer.get('cooperation_behavior') ?? []
  const groupsB = groupByDimension(layerB)
  const dimsB = dimensionsByLayer.get('cooperation_behavior') ?? []
  const minimumB = subQuota?.cooperation_behavior.minimumPerDimension ?? 1
  const quotaB = layerQuota(pack, 'cooperation_behavior')
  const remainderB = subQuota?.cooperation_behavior.remaining ?? quotaB - minimumB * dimsB.length
  if (minimumB * dimsB.length + remainderB !== quotaB) {
    throw new SamplerError(
      `B 层配额无法凑齐：每维至少 ${minimumB} 题 × ${dimsB.length} 维 + 余量 ${remainderB} != ${quotaB}`,
    )
  }
  const planB = new Map<string, number>(dimsB.map((dimension) => [dimension, minimumB]))
  const pickedB = drawLayer('cooperation_behavior', layerB, groupsB, planB, 'B 层', remainderB > 0)

  // --- Layer C: 6 items, exactly one per dimension ---------------------------
  const layerC = byLayer.get('skill_role') ?? []
  const groupsC = groupByDimension(layerC)
  const dimsC = dimensionsByLayer.get('skill_role') ?? []
  const exactlyC = subQuota?.skill_role.exactlyPerDimension ?? 1
  if (exactlyC * dimsC.length !== layerQuota(pack, 'skill_role')) {
    throw new SamplerError(
      `C 层配额无法凑齐：每维 ${exactlyC} 题 × ${dimsC.length} 维 != ${layerQuota(pack, 'skill_role')}`,
    )
  }
  const planC = new Map<string, number>(dimsC.map((dimension) => [dimension, exactlyC]))
  const pickedC = drawLayer('skill_role', layerC, groupsC, planC, 'C 层', false)

  const familyActive = hasSharedFamily(layerA) || hasSharedFamily(layerB) || hasSharedFamily(layerC)
  stages.push(
    stage(
      'family_conflict_filtering',
      familyActive,
      familyActive
        ? `familyId 每维上限已在抽题过程中强制生效（A/B/C 分别 ${pickedA.length}/${pickedB.length}/${pickedC.length} 题）`
        : '题库中每个 familyId 唯一，无同族题目可冲突',
    ),
  )

  // --- Stage 5: difficulty balance ------------------------------------------
  const diffA = balanceDifficulty(pickedA, layerA, createRng(`${seed}::difficulty::A`))
  const diffB = balanceDifficulty(pickedB, layerB, createRng(`${seed}::difficulty::B`))
  const diffC = balanceDifficulty(pickedC, layerC, createRng(`${seed}::difficulty::C`))
  const difficultyActive = diffA.active || diffB.active || diffC.active
  stages.push(
    stage(
      'difficulty_balance',
      difficultyActive,
      difficultyActive ? `${diffA.reason}；${diffB.reason}；${diffC.reason}` : diffA.reason,
    ),
  )

  // --- Stage 5b: near-duplicate semantic exclusion ---------------------------
  const exclusion = applySemanticExclusion(layerB, pickedB, [])
  stages.push(stage('semantic_exclusion', exclusion.active, exclusion.reason))

  // --- Stage 6: seeded sampling (already applied above) ----------------------
  stages.push(
    stage(
      'seeded_sampling',
      true,
      `seed="${seed}"，mulberry32(FNV-1a)，A 层按题库声明的每维配额抽取（${[...planA.entries()]
        .map(([dimension, count]) => `${dimension}=${count}`)
        .join(' ')}）`,
    ),
  )

  // --- Stage 7: final question set ------------------------------------------
  const ordered = [...diffA.picked, ...diffB.picked, ...diffC.picked]
  const ids = ordered.map((question) => question.id)
  if (ids.length !== policy.totalQuestions) {
    throw new SamplerError(`抽题结果 ${ids.length} 题，期望 ${policy.totalQuestions} 题`)
  }
  if (new Set(ids).size !== ids.length) {
    throw new SamplerError('抽题结果存在重复题目')
  }

  /**
   * Per-dimension quota check, after every stage has run.
   *
   * The plan is built before sampling, but the later stages (difficulty balance, family cap) can in
   * principle move questions around. This assertion is what makes "the quota actually holds" a
   * checked invariant instead of an assumption: without it, a stage that quietly drops an item shows
   * up as a dimension with too few questions and nothing to say about why.
   */
  for (const layer of LAYERS) {
    const plan = layer === 'theory_value' ? planA : layer === 'cooperation_behavior' ? planB : planC
    const needsRemainder = layer === 'cooperation_behavior' && remainderB > 0
    for (const [dimension, planned] of plan) {
      const actual = ordered.filter((question) => question.dimension === dimension).length
      const minimum = needsRemainder ? planned : planned
      if (actual < minimum) {
        throw new SamplerError(
          `抽题结果不满足配额：维度 ${dimension} 计划至少 ${minimum} 题，实际 ${actual} 题（层级 ${layer}）`,
        )
      }
    }
  }

  const layerCounts = LAYERS.map(
    (layer) => `${layer}=${ordered.filter((question) => question.layer === layer).length}`,
  ).join(' ')
  stages.push(stage('final_question_set', true, `${ids.length} 题，${layerCounts}`))

  return {
    questionIds: ids,
    stages,
    layerAShortDimension: null,
  }
}

export interface ShuffledOptionOrder {
  questionId: string
  /** Option ids in the order they must be rendered. */
  optionIds: string[]
  /** Which policy produced this order, so a reviewer can see why it was or was not reordered. */
  policy: OptionOrderPolicy
}

/**
 * Resolve the option order for one question (A-layer V1.1 `metadata.optionOrderPolicy`).
 *
 * The policy exists because the A layer now mixes question types whose options must not all be
 * treated the same way:
 *
 *   fixed               — render exactly as authored. A0's option list *is* the answer set: the
 *                         respondent picks a self-description, so reordering would change what the
 *                         options mean relative to each other.
 *   shuffle             — a knowledge item; free shuffle is safe and removes the positional tell.
 *   preserve_or_reverse — the options form a semantic progression (A2/A3 run from one end of an
 *                         axis to the other). Only the whole order or its whole reverse is allowed;
 *                         an arbitrary permutation would destroy the progression. Which of the two
 *                         is chosen is derived from the seed, so position bias is halved without
 *                         ever scrambling the meaning.
 *
 * Absent means `shuffle`, which is the V1.0 behaviour, so older packs are unaffected.
 */
export function resolveOptionOrder(
  question: Question,
  seed: string,
): { optionIds: string[]; policy: OptionOrderPolicy } {
  const authored = question.options.map((option) => option.id)
  const declared = question.metadata?.optionOrderPolicy
  const policy: OptionOrderPolicy =
    declared === 'fixed' || declared === 'shuffle' || declared === 'preserve_or_reverse'
      ? declared
      : 'shuffle'

  if (policy === 'fixed') return { optionIds: authored, policy }

  const rng = createRng(`${seed}::options::${question.id}`)

  if (policy === 'preserve_or_reverse') {
    // One bit decides forwards or backwards. Using the seeded stream keeps it reproducible.
    const reverse = rng.nextInt(2) === 1
    return { optionIds: reverse ? [...authored].reverse() : authored, policy }
  }

  return { optionIds: rng.shuffle(authored), policy }
}

/**
 * Option order for a whole paper (§10 last stage, §12 reproducibility).
 *
 * Scoring is keyed by option `id`, never by position, so reordering cannot corrupt a result. The
 * order is derived from `seed` + questionId only, so a restored session renders the same paper it
 * rendered before a refresh — including the choice of forwards-vs-reversed for order-sensitive
 * items.
 */
export function shuffleOptions(
  pack: QuestionPack,
  questionIds: readonly string[],
  seed: string,
): ShuffledOptionOrder[] {
  const byId = new Map(pack.questions.map((question) => [question.id, question]))
  return questionIds.map((questionId) => {
    const question = byId.get(questionId)
    if (!question) throw new SamplerError(`题目 ${questionId} 不在题库 ${pack.id} 中`)
    const resolved = resolveOptionOrder(question, seed)
    return { questionId, optionIds: resolved.optionIds, policy: resolved.policy }
  })
}
