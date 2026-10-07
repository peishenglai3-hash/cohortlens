import { createRng, type Rng } from './rng.ts'
import {
  LAYERS,
  type Layer,
  type Question,
  type QuestionPack,
  type ScoringModel,
  type EngineStageStatus,
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
  /** For layer A: which of the four macro dimensions received 3 instead of 4 items. */
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

/** How many distinct familyIds the pool could ever contribute (undefined familyIds are free). */
function availableFamilies(pool: readonly Question[]): number {
  const families = new Set<string>()
  let undefinedFamily = 0
  for (const question of pool) {
    if (question.familyId) families.add(question.familyId)
    else undefinedFamily += 1
  }
  return families.size + undefinedFamily
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
  const kept: Question[] = []
  const displaced: Question[] = []
  for (const question of plan) {
    if (kept.filter((entry) => entry.difficulty === question.difficulty).length >= cap) {
      displaced.push(question)
      continue
    }
    kept.push(question)
  }
  const usedIds = new Set(plan.map((question) => question.id))
  const extra = rng.shuffle(pool.filter((question) => !usedIds.has(question.id)))
  const picked = [...kept]
  for (const question of displaced) {
    const level = question.difficulty
    const usedAtLevel = picked.filter((entry) => entry.difficulty === level).length
    if (usedAtLevel < cap) {
      picked.push(question)
      continue
    }
    const levelAlternatives = extra.filter(
      (candidate) =>
        candidate.difficulty !== level &&
        picked.filter((entry) => entry.difficulty === candidate.difficulty).length < cap &&
        !picked.some((entry) => entry.id === candidate.id) &&
        !hasFamilyConflict([...picked, candidate]),
    )
    const fallbackAlternatives = extra.filter(
      (candidate) =>
        !picked.some((entry) => entry.id === candidate.id) &&
        !hasFamilyConflict([...picked, candidate]),
    )
    const replacement = levelAlternatives[0] ?? fallbackAlternatives[0]
    if (replacement) picked.push(replacement)
    else picked.push(question)
  }
  return {
    picked,
    active: true,
    reason: `按难度上限 ${cap} 均衡，位移 ${displaced.length} 题，最终 ${picked.length} 题`,
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

  const rng = createRng(seed)
  const policy = pack.assessmentPolicy
  const quota = policy.quota
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

  // --- Layer A: 15 items, per-dimension subQuota, short dimension rotates ----
  const layerA = byLayer.get('theory_value') ?? []
  const groupsA = groupByDimension(layerA)
  const dimsA = dimensionsByLayer.get('theory_value') ?? []
  if (dimsA.length === 0) throw new SamplerError('评分模型未声明任何 A 层维度')

  const previousShortDimensions = previousSessions
    .map((session) => session.shortDimension)
    .filter((dimension): dimension is string => Boolean(dimension))
  const lastShort = previousShortDimensions.at(-1)
  // Prefer a dimension that was not the most recent short one. Uniform choice among the rest.
  const eligible =
    dimsA.length > 1 && lastShort ? dimsA.filter((dimension) => dimension !== lastShort) : dimsA
  const shortDimension = rng.pick(eligible)

  const declaredSubQuotaA = subQuota?.theory_value ?? {}
  const declaredA = dimsA
    .map((dimension) => declaredSubQuotaA[dimension])
    .filter((value): value is number => value !== undefined)

  /**
   * A-layer plan, derived from the pack rather than hard-coded.
   *
   * The source README (line 26) fixes the assessment split at 4 + 4 + 4 + 3 and requires that
   * *which* dimension loses one item rotates ("不能永久固定同一维少抽"). The declared numbers
   * cannot therefore be bound to fixed dimensions.
   *
   * Construction:
   *   1. baseline = max declared per-dimension target (4 for bank V1.0) applied to every
   *      dimension, so the baseline total (16) exceeds the layer quota (15);
   *   2. remove `baselineTotal - quota` items, taking one from the rotating short dimension
   *      first and then from whichever dimension has the largest declared target (ties by id);
   *   3. if a pack's baseline total is *below* the quota, add the difference to the dimensions
   *      with the smallest current target (ties by declared order, then by id).
   *
   * Every step is deterministic and the sum is exact by construction, so the resulting plan
   * always equals the layer quota. This replaced an earlier arithmetic version that could emit
   * 4/4/4/4 or a negative count — see ADR-010.
   */
  const baselineA =
    declaredA.length > 0
      ? Math.max(...declaredA)
      : Math.ceil(layerQuota(pack, 'theory_value') / Math.max(1, dimsA.length))
  const declaredWeight = (dimension: string): number => declaredSubQuotaA[dimension] ?? baselineA
  /** Removal order: rotating short dimension first, then largest declared target. */
  const removalOrder = [...dimsA].sort((a, b) => {
    if (a === shortDimension) return -1
    if (b === shortDimension) return 1
    return declaredWeight(b) - declaredWeight(a) || (a < b ? -1 : 1)
  })
  /** Addition order: smallest current target, then declared order, then id. */
  const additionOrder = [...dimsA].sort((a, b) => (a < b ? -1 : 1))

  const planA = new Map<string, number>(dimsA.map((dimension) => [dimension, baselineA]))
  let delta = baselineA * dimsA.length - layerQuota(pack, 'theory_value')
  if (delta > 0) {
    let guard = 0
    let index = 0
    while (delta > 0) {
      if (guard > dimsA.length * (baselineA + 1) + 4) {
        throw new SamplerError(`A 层配额压缩未收敛：仍差 ${delta} 题`)
      }
      guard += 1
      const dimension = removalOrder[index % removalOrder.length]
      index += 1
      if (dimension === undefined) break
      const current = planA.get(dimension) ?? 0
      if (current <= 1) continue
      planA.set(dimension, current - 1)
      delta -= 1
    }
  } else if (delta < 0) {
    let remaining = -delta
    let guard = 0
    while (remaining > 0) {
      if (guard > dimsA.length * 64) {
        throw new SamplerError(`A 层配额补齐未收敛：仍差 ${remaining} 题`)
      }
      guard += 1
      const dimension = additionOrder.reduce<string | undefined>((best, candidate) => {
        if (best === undefined) return candidate
        const bestCount = planA.get(best) ?? 0
        const candidateCount = planA.get(candidate) ?? 0
        return candidateCount < bestCount ? candidate : best
      }, undefined)
      if (dimension === undefined) break
      planA.set(dimension, (planA.get(dimension) ?? 0) + 1)
      remaining -= 1
    }
  }

  const sumA = [...planA.values()].reduce((a, b) => a + b, 0)
  if (sumA !== quota.theory_value) {
    throw new SamplerError(
      `A 层配额无法凑齐：计划 ${sumA} 题，需要 ${quota.theory_value} 题（各维目标 ${[
        ...planA.entries(),
      ]
        .map(([dimension, count]) => `${dimension}=${count}`)
        .join(', ')}）`,
    )
  }

  /**
   * Draw a layer under both constraints at once and retry the draw if the family constraint
   * cannot be met by that attempt. Because the constraint is enforced *during* the draw, a
   * successful return always carries exactly the requested number of items.
   */
  function drawLayer(
    layerName: string,
    pool: readonly Question[],
    groups: Map<string, Question[]>,
    plan: ReadonlyMap<string, number>,
    planDescription: string,
    needsEvenRemainder: boolean,
  ): Question[] {
    const familyConstraint = hasSharedFamily(pool)
    const dimensions = [...plan.keys()]
    const totalNeeded = [...plan.values()].reduce((a, b) => a + b, 0)
    if (familyConstraint && availableFamilies(pool) < totalNeeded) {
      throw new SamplerError(
        `${layerName} 层要求在 ${totalNeeded} 题内不重复 familyId，但题库只有 ${availableFamilies(pool)} 个可用 family，无法满足 avoidSameFamily`,
      )
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
        taken.push(...attemptRng.sample(candidates, need))
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

      if (!familyConstraint || !hasFamilyConflict(taken)) return taken
    }

    throw new SamplerError(
      `${layerName} 层在 250 次重抽内仍无法同时满足配额与 avoidSameFamily 约束；请检查题库的 familyId 分布`,
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
        ? `avoidSameFamily 已在抽题过程中强制生效（A/B/C 分别 ${pickedA.length}/${pickedB.length}/${pickedC.length} 题）`
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
      `seed="${seed}"，mulberry32(FNV-1a)，A 层少抽维度 ${shortDimension}`,
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
  const layerCounts = LAYERS.map(
    (layer) => `${layer}=${ordered.filter((question) => question.layer === layer).length}`,
  ).join(' ')
  stages.push(stage('final_question_set', true, `${ids.length} 题，${layerCounts}`))

  return {
    questionIds: ids,
    stages,
    layerAShortDimension: shortDimension,
  }
}

export interface ShuffledOptionOrder {
  questionId: string
  /** Option ids in the order they must be rendered. Author order is preserved inside. */
  optionIds: string[]
}

/**
 * Option shuffle (§10 last stage, §12 reproducibility).
 *
 * Scoring is keyed by option `id`, never by position, so shuffling cannot corrupt a result.
 * The order is derived from `seed` + questionId only, so a restored session renders the same
 * paper it rendered before a refresh.
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
    const rng = createRng(`${seed}::options::${questionId}`)
    return {
      questionId,
      optionIds: rng.shuffle(question.options.map((option) => option.id)),
    }
  })
}
