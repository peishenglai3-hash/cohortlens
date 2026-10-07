import {
  LAYERS,
  type Layer,
  type Question,
  type QuestionPack,
  type RoleModel,
  type ScoringModel,
} from './schemas.ts'
import type { SamplerStageReport } from '../engine/sampler.ts'

/**
 * Question Bank validator.
 *
 * Engineering Bible §51 requires `npm run validate:questions` to detect duplicated ids, missing
 * fields, too few options, unknown dimensions, illegal scoring keys, family conflicts,
 * insufficient questions per layer, and quota infeasibility.
 *
 * Two design rules govern this file, and they matter more than the individual checks:
 *
 *  1. Every finding carries a machine-readable `code` and the id it concerns, so a failure can
 *     be located rather than argued about.
 *  2. A check that found a real defect is reported as `error`. A check that is *structurally
 *     inert* under the loaded pack (because the pack has no reverse items, or no repeated
 *     families) is reported as `inactive`, never silently dropped and never faked as a pass.
 */

export type Severity = 'error' | 'warning' | 'inactive' | 'pass'

export interface Finding {
  severity: Severity
  code: string
  message: string
  /** Question ids, dimension ids or group ids this finding concerns. */
  subjects: string[]
}

export interface DimensionTally {
  layer: Layer
  dimension: string
  label: string
  bankCount: number
  perAssessment: number
}

export interface ValidationReport {
  packId: string
  packVersion: string
  scoringVersion: string
  roleModelVersion: string
  counts: {
    questions: number
    errors: number
    warnings: number
    inactive: number
    passed: number
  }
  dimensions: DimensionTally[]
  samplerStages: SamplerStageReport[]
  findings: Finding[]
  ok: boolean
}

export interface ValidationInput {
  pack: QuestionPack
  scoring: ScoringModel
  roleModel: RoleModel
  /** Layer statuses produced by the sampler, so the report states which §10 stages are live. */
  samplerStages: SamplerStageReport[]
}

/**
 * Sourced from `domain/boundaries.ts`, which is the single definition shared by the role-fit
 * engine, the report chain and this validator (ADR-007). Imported for local use and re-exported
 * so existing call sites keep working.
 */
import { REQUIRED_FORBIDDEN_LANGUAGE } from './boundaries.ts'
export { REQUIRED_FORBIDDEN_LANGUAGE }

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item)
  }
  return map
}

function layerKeyOf(layer: Layer): 'layerA' | 'layerB' | 'layerC' {
  if (layer === 'theory_value') return 'layerA'
  if (layer === 'cooperation_behavior') return 'layerB'
  return 'layerC'
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) dupes.add(value)
    else seen.add(value)
  }
  return [...dupes]
}

export function validateQuestionPack({
  pack,
  scoring,
  roleModel,
  samplerStages,
}: ValidationInput): ValidationReport {
  const questions = pack.questions
  const questionById = byId(questions)

  const dimensionLayer: Record<string, Layer> = {}
  for (const layer of LAYERS) {
    const section = scoring[layerKeyOf(layer)]
    for (const [dimensionId] of Object.entries(section.dimensions)) {
      dimensionLayer[dimensionId] = layer
    }
  }
  const validDimensions = new Set(Object.keys(dimensionLayer))
  const roleIds = new Set(roleModel.roles.map((role) => role.id))

  const expectedPerAssessment: Record<string, number> = {}
  for (const [dimensionId, count] of Object.entries(
    pack.assessmentPolicy.subQuota?.theory_value ?? {},
  )) {
    expectedPerAssessment[dimensionId] = count
  }

  const banksByDimension = new Map<string, Question[]>()
  for (const question of questions) {
    const list = banksByDimension.get(question.dimension) ?? []
    list.push(question)
    banksByDimension.set(question.dimension, list)
  }

  const findings: Finding[] = []
  const add = (finding: Finding | Finding[]): void => {
    findings.push(...(Array.isArray(finding) ? finding : [finding]))
  }
  const check = (code: string, run: () => Finding | Finding[]): void => {
    try {
      add(run())
    } catch (error) {
      findings.push({
        severity: 'error',
        code: `${code}_threw`,
        message: `检查项自身抛出异常：${error instanceof Error ? error.message : String(error)}`,
        subjects: [],
      })
    }
  }

  // --- structural -----------------------------------------------------------

  check('duplicate_question_id', () => {
    const dupes = duplicates(questions.map((question) => question.id))
    return dupes.length === 0
      ? {
          severity: 'pass',
          code: 'duplicate_question_id',
          message: '题目 ID 全部唯一。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'duplicate_question_id',
          message: `发现重复题目 ID：${dupes.join(', ')}`,
          subjects: dupes,
        }
  })

  check('duplicate_option_id', () => {
    const dupes: string[] = []
    for (const question of questions) {
      for (const optionId of duplicates(question.options.map((option) => option.id))) {
        dupes.push(`${question.id}/${optionId}`)
      }
    }
    return dupes.length === 0
      ? {
          severity: 'pass',
          code: 'duplicate_option_id',
          message: '选项 ID 在题内全部唯一。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'duplicate_option_id',
          message: `发现重复选项 ID：${dupes.slice(0, 20).join(', ')}`,
          subjects: dupes,
        }
  })

  check('too_few_options', () => {
    const bad = questions
      .filter((question) => question.options.length < 2)
      .map((question) => question.id)
    return bad.length === 0
      ? { severity: 'pass', code: 'too_few_options', message: '每题选项数均 >= 2。', subjects: [] }
      : {
          severity: 'error',
          code: 'too_few_options',
          message: `选项不足的题目：${bad.join(', ')}`,
          subjects: bad,
        }
  })

  check('option_count_uniform', () => {
    const sizes = new Set(questions.map((question) => question.options.length))
    return sizes.size === 1
      ? {
          severity: 'pass',
          code: 'option_count_uniform',
          message: `每题的选项数一致，均为 ${[...sizes][0]}。`,
          subjects: [],
        }
      : {
          severity: 'warning',
          code: 'option_count_uniform',
          message: `选项数不一致，出现的选项数：${[...sizes].sort((a, b) => a - b).join(', ')}。原始回答的可比性会下降。`,
          subjects: [],
        }
  })

  check('missing_required_field', () => {
    const missing: string[] = []
    for (const question of questions) {
      if (!question.prompt.trim()) missing.push(`${question.id}:prompt`)
      if (!question.dimension.trim()) missing.push(`${question.id}:dimension`)
      if (!question.subDimension.trim()) missing.push(`${question.id}:subDimension`)
    }
    return missing.length === 0
      ? {
          severity: 'pass',
          code: 'missing_required_field',
          message: '必填字段齐全。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'missing_required_field',
          message: `存在空字段：${missing.slice(0, 20).join(', ')}`,
          subjects: missing,
        }
  })

  // --- schema / scoring integrity -------------------------------------------

  check('unknown_dimension', () => {
    const bad = [...new Set(questions.map((question) => question.dimension))].filter(
      (dimension) => !validDimensions.has(dimension),
    )
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'unknown_dimension',
          message: `全部 dimension 均存在于评分模型（${validDimensions.size} 个维度）。`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'unknown_dimension',
          message: `评分模型中不存在的 dimension：${bad.join(', ')}`,
          subjects: bad,
        }
  })

  check('dimension_layer_mismatch', () => {
    const bad = questions
      .filter((question) => dimensionLayer[question.dimension] !== question.layer)
      .map((question) => `${question.id}:${question.layer}/${question.dimension}`)
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'dimension_layer_mismatch',
          message: '题目 layer 与 dimension 归属一致。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'dimension_layer_mismatch',
          message: `layer 与 dimension 不匹配：${bad.slice(0, 20).join(', ')}`,
          subjects: bad,
        }
  })

  check('illegal_scoring_key', () => {
    const bad: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        for (const key of Object.keys(option.scoring ?? {})) {
          if (!validDimensions.has(key)) bad.push(`${question.id}/${option.id}:${key}`)
        }
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'illegal_scoring_key',
          message: 'scoring 键全部合法。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'illegal_scoring_key',
          message: `非法 scoring 键：${bad.slice(0, 20).join(', ')}`,
          subjects: bad,
        }
  })

  check('option_missing_scoring', () => {
    const bad: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        const signals = Object.values(option.scoring ?? {})
        if (signals.length === 0) bad.push(`${question.id}/${option.id}`)
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'option_missing_scoring',
          message: '每个选项都带 scoring。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'option_missing_scoring',
          message: `缺少 scoring 的选项：${bad.slice(0, 20).join(', ')}`,
          subjects: bad,
        }
  })

  check('scoring_key_not_matching_own_dimension', () => {
    const bad: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        const keys = Object.keys(option.scoring ?? {})
        if (keys.length === 1 && keys[0] !== question.dimension) {
          bad.push(`${question.id}/${option.id}:${keys[0]}`)
        }
        if (keys.length > 1) bad.push(`${question.id}/${option.id}:multi(${keys.join('|')})`)
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'scoring_key_not_matching_own_dimension',
          message: '每题的选项只为一个维度打信号，且与题目 dimension 一致。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'scoring_key_not_matching_own_dimension',
          message: `信号维度与题目维度不一致：${bad.slice(0, 20).join(', ')}`,
          subjects: bad,
        }
  })

  check('illegal_role_signal_key', () => {
    const bad: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        for (const key of Object.keys(option.roleSignals ?? {})) {
          if (!roleIds.has(key)) bad.push(`${question.id}/${option.id}:${key}`)
        }
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'illegal_role_signal_key',
          message: 'roleSignals 键全部对应角色模型。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'illegal_role_signal_key',
          message: `非法 roleSignals 键：${bad.slice(0, 20).join(', ')}`,
          subjects: bad,
        }
  })

  check('role_signal_on_theory_layer', () => {
    const bad = questions
      .filter((question) => question.layer === 'theory_value')
      .filter((question) => question.options.some((option) => option.roleSignals !== undefined))
      .map((question) => question.id)
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'role_signal_on_theory_layer',
          message: 'A 层题目不携带任何 roleSignals（A 层不得进入角色适配）。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'role_signal_on_theory_layer',
          message: `A 层题目携带 roleSignals，会把理论层信号带进角色适配：${bad.join(', ')}`,
          subjects: bad,
        }
  })

  // --- content-level quality signals ---------------------------------------

  check('degenerate_score_spread', () => {
    const flat: string[] = []
    const floorAboveZero: string[] = []
    const keyTransparent: string[] = []
    for (const question of questions) {
      const values = question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)
      if (new Set(values).size === 1) flat.push(question.id)
      if (Math.min(...values) > 0) floorAboveZero.push(`${question.id}(最低${Math.min(...values)})`)
      if (values.filter((value) => value === scoring.scale.maxPerQuestion).length === 1) {
        keyTransparent.push(question.id)
      }
    }
    const out: Finding[] = []
    out.push(
      flat.length === 0
        ? {
            severity: 'pass',
            code: 'degenerate_score_spread',
            message: '每题至少有两个不同分值。',
            subjects: [],
          }
        : {
            severity: 'error',
            code: 'degenerate_score_spread',
            message: `所有选项分值相同的题目（无论怎么答都得分一样，无区分度）：${flat.join(', ')}`,
            subjects: flat,
          },
    )
    out.push(
      floorAboveZero.length === 0
        ? {
            severity: 'pass',
            code: 'unreachable_score_floor',
            message: '每题的最低选项都能取到 0。',
            subjects: [],
          }
        : {
            severity: 'warning',
            code: 'unreachable_score_floor',
            message: `${floorAboveZero.length} 道题的最低选项分值大于 0，抽到该题时对应维度的 0 分档不可达（会产生范围受限的归一化分数）。`,
            subjects: floorAboveZero,
          },
    )
    out.push(
      keyTransparent.length === questions.length
        ? {
            severity: 'warning',
            code: 'transparent_single_key',
            message: `全部 ${questions.length} 道题都恰好只有一个选项取到满分 ${scoring.scale.maxPerQuestion}，其余选项均 <= 1：表面效度上"只有一个明显好答案"。这是题库作者已知的设计取舍（源 README 第 76-83 行），依赖 optionShuffle 与跨题一致性缓解，不能当作已解决的测量问题。`,
            subjects: [],
          }
        : {
            severity: 'pass',
            code: 'transparent_single_key',
            message: `${questions.length - keyTransparent.length} 道题有部分给分梯度。`,
            subjects: [],
          },
    )
    return out
  })

  check('key_position_tell', () => {
    const positions = new Map<string, number>()
    for (const question of questions) {
      const values = question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)
      const index = values.indexOf(scoring.scale.maxPerQuestion)
      if (index < 0) continue
      const label = String.fromCharCode(65 + index)
      positions.set(label, (positions.get(label) ?? 0) + 1)
    }
    const summary = [...positions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
    const top = [...positions.entries()].sort((a, b) => b[1] - a[1])[0]
    const share = top ? top[1] / questions.length : 0
    return share > 0.5
      ? {
          severity: 'warning',
          code: 'key_position_tell',
          message: `满分选项的位置分布高度不均（${summary.join(', ')}，最高位占 ${(share * 100).toFixed(1)}%）。运行时必须开启 optionShuffle，且人工审阅版题库（md）会直接暴露答案位置。`,
          subjects: [],
        }
      : {
          severity: 'pass',
          code: 'key_position_tell',
          message: `满分选项位置分布：${summary.join(', ')}`,
          subjects: [],
        }
  })

  check('negative_stem_without_reverse_flag', () => {
    const negativeMarkers = ['最不', '最没有', '不属于', '错误的是', '不正确']
    const suspicious = questions
      .filter((question) => negativeMarkers.some((marker) => question.prompt.includes(marker)))
      .filter((question) => question.reverse !== true)
      .map((question) => question.id)
    if (suspicious.length === 0) {
      return {
        severity: 'pass',
        code: 'negative_stem_without_reverse_flag',
        message: '未发现反向表述却未标记的题目。',
        subjects: [],
      }
    }
    return {
      severity: 'warning',
      code: 'negative_stem_without_reverse_flag',
      message: `题干为反向表述（"最不…"）但 reverse !== true：${suspicious.join(', ')}。若后续有代码"纠正"反向题，会静默倒转这些题的分数。`,
      subjects: suspicious,
    }
  })

  check('truncated_stem', () => {
    const truncated = questions
      .filter((question) => /通常？$/.test(question.prompt.trim()))
      .map((question) => question.id)
    return truncated.length === 0
      ? {
          severity: 'pass',
          code: 'truncated_stem',
          message: '未发现缺少谓语的题干。',
          subjects: [],
        }
      : {
          severity: 'warning',
          code: 'truncated_stem',
          message: `${truncated.length} 道题的题干以"通常？"结尾而缺少谓语，答题者需要靠选项反推问题含义：${truncated.join(', ')}。`,
          subjects: truncated,
        }
  })

  check('forbidden_output_language', () => {
    const declared = new Set([
      ...(roleModel.forbiddenLanguage ?? []),
      ...REQUIRED_FORBIDDEN_LANGUAGE,
    ])
    const missing = REQUIRED_FORBIDDEN_LANGUAGE.filter(
      (phrase) => !(roleModel.forbiddenLanguage ?? []).includes(phrase),
    )
    const hits: string[] = []
    for (const question of questions) {
      const haystack = [question.prompt, ...question.options.map((option) => option.text)].join(
        '\n',
      )
      for (const phrase of declared) {
        // '忠诚' inside a longer word is still a hit; substring matching is intentional.
        if (haystack.includes(phrase)) hits.push(`${question.id}:${phrase}`)
      }
    }
    const out: Finding[] = []
    out.push(
      hits.length === 0
        ? {
            severity: 'pass',
            code: 'forbidden_output_language',
            message: '题干与选项未出现禁用输出语。',
            subjects: [],
          }
        : {
            severity: 'warning',
            code: 'forbidden_output_language',
            message: `题干或选项出现禁用输出语（需人工确认是"讨论对象"还是"评价他人"）：${hits.slice(0, 20).join(', ')}`,
            subjects: hits,
          },
    )
    out.push(
      missing.length === 0
        ? {
            severity: 'pass',
            code: 'forbidden_language_list_gap',
            message: '角色模型的 forbiddenLanguage 已覆盖产品边界要求的全部禁用词。',
            subjects: [],
          }
        : {
            severity: 'warning',
            code: 'forbidden_language_list_gap',
            message: `冻结的 role-model forbiddenLanguage 未覆盖：${missing.join('、')}。代码侧已按并集强制执行（ADR-007），但内容文件本身建议补齐。`,
            subjects: missing,
          },
    )
    return out
  })

  // --- consistency groups ---------------------------------------------------

  check('consistency_group_reference', () => {
    const bad: string[] = []
    for (const group of scoring.confidence.consistencyGroups) {
      for (const questionId of group.questions) {
        if (!questionById.has(questionId)) bad.push(`${group.id}->${questionId}`)
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'consistency_group_reference',
          message: `${scoring.confidence.consistencyGroups.length} 个一致性组引用的题目全部存在。`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'consistency_group_reference',
          message: `一致性组引用了不存在的题目：${bad.join(', ')}`,
          subjects: bad,
        }
  })

  check('consistency_group_single_use', () => {
    const uses = new Map<string, number>()
    for (const group of scoring.confidence.consistencyGroups) {
      for (const questionId of group.questions) {
        uses.set(questionId, (uses.get(questionId) ?? 0) + 1)
      }
    }
    const shared = [...uses.entries()].filter(([, count]) => count > 1).map(([id]) => id)
    return shared.length === 0
      ? {
          severity: 'pass',
          code: 'consistency_group_single_use',
          message: '没有题目被多个一致性组同时引用。',
          subjects: [],
        }
      : {
          severity: 'warning',
          code: 'consistency_group_single_use',
          message: `以下题目同时属于多个一致性组，一致性扣分会叠加：${shared.join(', ')}。`,
          subjects: shared,
        }
  })

  check('consistency_group_cross_layer', () => {
    const crossLayer = scoring.confidence.consistencyGroups
      .filter((group) => new Set(group.questions.map((id) => questionById.get(id)?.layer)).size > 1)
      .map((group) => group.id)
    return crossLayer.length === 0
      ? {
          severity: 'pass',
          code: 'consistency_group_cross_layer',
          message: '一致性组不跨层。',
          subjects: [],
        }
      : {
          severity: 'warning',
          code: 'consistency_group_cross_layer',
          message: `以下一致性组跨层（A 层与 B 层混在一起），其语义是把"理论判断"与"自陈行为"当作同一件事比较：${crossLayer.join(', ')}。规则本身只降低置信度，但需要在人工复核时说明。`,
          subjects: crossLayer,
        }
  })

  check('consistency_group_political_label', () => {
    const flagged = scoring.confidence.consistencyGroups
      .filter((group) =>
        /plural|pluralism|minority|政治|立场|loyalty|忠诚|意识形态/.test(group.note),
      )
      .map((group) => `${group.id}:${group.note}`)
    return flagged.length === 0
      ? {
          severity: 'pass',
          code: 'consistency_group_political_label',
          message: '一致性组备注未使用政治/立场类标签。',
          subjects: [],
        }
      : {
          severity: 'warning',
          code: 'consistency_group_political_label',
          message: `一致性组备注使用了政治或立场类标签，会把个人层面推断贴在答题者身上，建议改名：${flagged.join(' | ')}`,
          subjects: flagged,
        }
  })

  // --- layer composition & sampler feasibility ------------------------------

  check('layer_counts', () => {
    const actual = new Map<Layer, number>()
    for (const layer of LAYERS) actual.set(layer, 0)
    for (const question of questions)
      actual.set(question.layer, (actual.get(question.layer) ?? 0) + 1)
    /**
     * A single assessment consumes `quota[layer]` items from the layer, but never more than
     * `dims(layer)` items from any one dimension. So the bank must hold at least
     * `sum over dimensions of min(perDimensionDemand, quota[layer])` items for the layer to be
     * drawable, and holding exactly that many means the layer is a minimum viable pool.
     */
    const descriptions: string[] = []
    let minViableTotal = 0
    for (const layer of LAYERS) {
      const layerQuota = pack.assessmentPolicy.quota[layer] ?? 0
      const dimensionIds = Object.keys(scoring[layerKeyOf(layer)].dimensions)
      const demandPerDimension = dimensionIds.map((dimension) => {
        const declared = expectedPerAssessment[dimension]
        if (declared !== undefined && declared > 0) return declared
        return layer === 'skill_role'
          ? (pack.assessmentPolicy.subQuota?.skill_role.exactlyPerDimension ?? 1)
          : 1
      })
      const minViable = demandPerDimension.reduce(
        (sum, demand) => sum + Math.min(demand, layerQuota),
        0,
      )
      minViableTotal += minViable
      const have = actual.get(layer) ?? 0
      descriptions.push(
        `${layer}: 题库 ${have} 题，可抽单次配额 ${layerQuota} 题所需的最小池 ${minViable} 题，重复系数 ${(have / Math.max(1, minViable)).toFixed(2)}x`,
      )
    }
    return {
      severity: 'pass',
      code: 'layer_counts',
      message: `${descriptions.join('；')}。三层最小池合计 ${minViableTotal} 题。`,
      subjects: [],
    }
  })

  check('layer_insufficient', () => {
    const bad: string[] = []
    for (const layer of LAYERS) {
      const needed = pack.assessmentPolicy.quota[layer] ?? 0
      const have = questions.filter((question) => question.layer === layer).length
      if (have < needed) bad.push(`${layer}: 需要 ${needed} 题，题库只有 ${have} 题`)
    }
    if (bad.length > 0) {
      return {
        severity: 'error',
        code: 'layer_insufficient',
        message: bad.join('；'),
        subjects: bad,
      }
    }
    const pool = new Map<Layer, number>()
    for (const layer of LAYERS) {
      pool.set(layer, questions.filter((question) => question.layer === layer).length)
    }
    return {
      severity: 'pass',
      code: 'layer_insufficient',
      message: LAYERS.map(
        (layer) => `${layer} 题库 ${pool.get(layer)} >= 配额 ${pack.assessmentPolicy.quota[layer]}`,
      ).join('；'),
      subjects: [],
    }
  })

  check('dimension_insufficient', () => {
    const bad: string[] = []
    for (const dimensionId of validDimensions) {
      const needed = expectedPerAssessment[dimensionId]
      if (needed === undefined) continue
      const have = banksByDimension.get(dimensionId)?.length ?? 0
      if (have < needed) bad.push(`${dimensionId}: 单次需 ${needed} 题，题库只有 ${have} 题`)
    }
    // B layer: at least `minimumPerDimension` per dimension.
    const layerB = pack.assessmentPolicy.subQuota?.cooperation_behavior
    if (layerB) {
      for (const [dimensionId, label] of Object.entries(scoring.layerB.dimensions)) {
        const have = banksByDimension.get(dimensionId)?.length ?? 0
        if (have < layerB.minimumPerDimension) {
          bad.push(
            `${dimensionId}(${label}): 单次需至少 ${layerB.minimumPerDimension} 题，题库只有 ${have} 题`,
          )
        }
      }
    }
    const layerC = pack.assessmentPolicy.subQuota?.skill_role
    if (layerC) {
      for (const dimensionId of Object.keys(scoring.layerC.dimensions)) {
        const have = banksByDimension.get(dimensionId)?.length ?? 0
        if (have < layerC.exactlyPerDimension) {
          bad.push(
            `${dimensionId}: 单次需恰好 ${layerC.exactlyPerDimension} 题，题库只有 ${have} 题`,
          )
        }
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'dimension_insufficient',
          message: '所有维度在单次配额的题量要求下都有足够题目。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'dimension_insufficient',
          message: `维度题量不足，无法生成 30 题：${bad.join('；')}`,
          subjects: bad,
        }
  })

  check('quota_total', () => {
    const quota = pack.assessmentPolicy.quota
    const sum = LAYERS.reduce((total, layer) => total + (quota[layer] ?? 0), 0)
    return sum === pack.assessmentPolicy.totalQuestions
      ? {
          severity: 'pass',
          code: 'quota_total',
          message: `层级配额之和 ${sum} 等于 totalQuestions ${pack.assessmentPolicy.totalQuestions}。`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'quota_total',
          message: `层级配额之和 ${sum} 不等于 totalQuestions ${pack.assessmentPolicy.totalQuestions}。`,
          subjects: [],
        }
  })

  check('subquota_totals', () => {
    const out: string[] = []
    const sub = pack.assessmentPolicy.subQuota
    if (!sub)
      return {
        severity: 'inactive',
        code: 'subquota_totals',
        message: '题库未声明 subQuota，跳过。',
        subjects: [],
      }
    const sumA = Object.values(sub.theory_value).reduce((a, b) => a + b, 0)
    if (sumA !== pack.assessmentPolicy.quota.theory_value) {
      out.push(`A 层 subQuota 之和 ${sumA} != A 层配额 ${pack.assessmentPolicy.quota.theory_value}`)
    }
    const bDims = Object.keys(scoring.layerB.dimensions).length
    const sumB =
      sub.cooperation_behavior.minimumPerDimension * bDims + sub.cooperation_behavior.remaining
    if (sumB !== pack.assessmentPolicy.quota.cooperation_behavior) {
      out.push(
        `B 层 subQuota 合计 ${sumB} != B 层配额 ${pack.assessmentPolicy.quota.cooperation_behavior}`,
      )
    }
    const cDims = Object.keys(scoring.layerC.dimensions).length
    const sumC = sub.skill_role.exactlyPerDimension * cDims
    if (sumC !== pack.assessmentPolicy.quota.skill_role) {
      out.push(`C 层 subQuota 合计 ${sumC} != C 层配额 ${pack.assessmentPolicy.quota.skill_role}`)
    }
    return out.length === 0
      ? {
          severity: 'pass',
          code: 'subquota_totals',
          message: '三层 subQuota 与层级配额自洽。',
          subjects: [],
        }
      : { severity: 'error', code: 'subquota_totals', message: out.join('；'), subjects: out }
  })

  check('family_conflict', () => {
    const families = new Map<string, string[]>()
    for (const question of questions) {
      if (!question.familyId) continue
      const list = families.get(question.familyId) ?? []
      list.push(question.id)
      families.set(question.familyId, list)
    }
    const conflicting = [...families.entries()].filter(([, ids]) => ids.length > 1)
    if (questions.every((question) => question.familyId === undefined)) {
      return {
        severity: 'inactive',
        code: 'family_conflict',
        message: '题库没有任何 familyId，同族冲突过滤阶段在本版题库下未激活。',
        subjects: [],
      }
    }
    if (conflicting.length === 0) {
      return {
        severity: 'inactive',
        code: 'family_conflict',
        message: `有 ${families.size} 个 familyId 但全部唯一，没有同族题目，同族冲突过滤阶段在本版题库下未激活。`,
        subjects: [],
      }
    }
    const overfull = conflicting.filter(([, ids]) => ids.length > 3)
    return overfull.length === 0
      ? {
          severity: 'pass',
          code: 'family_conflict',
          message: `${conflicting.length} 个 family 含多题，抽样时需避免同族重复，均已 <= 3 题，可以错开。`,
          subjects: conflicting.map(([familyId]) => familyId),
        }
      : {
          severity: 'error',
          code: 'family_conflict',
          message: `以下 family 含超过 3 道题，若同族题必须错开则可能凑不满配额：${overfull
            .map(([familyId, ids]) => `${familyId}(${ids.length})`)
            .join(', ')}`,
          subjects: overfull.map(([familyId]) => familyId),
        }
  })

  check('reverse_items', () => {
    const reverseCount = questions.filter((question) => question.reverse === true).length
    return reverseCount === 0
      ? {
          severity: 'inactive',
          code: 'reverse_items',
          message: '题库中没有 reverse=true 的题目，反向题冲突检测阶段在本版题库下未激活。',
          subjects: [],
        }
      : {
          severity: 'pass',
          code: 'reverse_items',
          message: `存在 ${reverseCount} 道反向题，反向题冲突检测阶段处于激活状态。`,
          subjects: [],
        }
  })

  check('difficulty_balance', () => {
    const levels = new Set(questions.map((question) => question.difficulty))
    return levels.size <= 1
      ? {
          severity: 'inactive',
          code: 'difficulty_balance',
          message: `全部 ${questions.length} 道题的 difficulty 都是 ${[...levels][0]}，难度平衡阶段在本版题库下未激活。`,
          subjects: [],
        }
      : {
          severity: 'pass',
          code: 'difficulty_balance',
          message: `题库含 ${levels.size} 个难度档位，难度平衡阶段处于激活状态。`,
          subjects: [],
        }
  })

  check('option_shuffle_enabled', () => {
    const sampling = pack.assessmentPolicy.sampling
    if (!sampling)
      return {
        severity: 'inactive',
        code: 'option_shuffle_enabled',
        message: '题库未声明 sampling 策略。',
        subjects: [],
      }
    return sampling.optionShuffle
      ? {
          severity: 'pass',
          code: 'option_shuffle_enabled',
          message: '题库要求 optionShuffle，运行时必须打乱选项顺序。',
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'option_shuffle_enabled',
          message: '题库关闭了 optionShuffle，而满分选项位置分布高度不均，答案位置会直接泄漏。',
          subjects: [],
        }
  })

  check('sampler_stages', () => {
    const inactive = samplerStages.filter((stage) => !stage.active)
    return inactive.length === 0
      ? {
          severity: 'pass',
          code: 'sampler_stages',
          message: `抽题引擎的 ${samplerStages.length} 个阶段全部激活。`,
          subjects: [],
        }
      : {
          severity: 'inactive',
          code: 'sampler_stages',
          message: `抽题引擎有 ${inactive.length}/${samplerStages.length} 个阶段在本版题库下未激活：${inactive
            .map((stage) => `${stage.stage}（${stage.reason}）`)
            .join('；')}`,
          subjects: inactive.map((stage) => stage.stage),
        }
  })

  // --- dimensions table -----------------------------------------------------

  const dimensions: DimensionTally[] = []
  for (const layer of LAYERS) {
    for (const [dimensionId, label] of Object.entries(scoring[layerKeyOf(layer)].dimensions)) {
      const bankCount = banksByDimension.get(dimensionId)?.length ?? 0
      const perAssessment =
        expectedPerAssessment[dimensionId] ??
        (layer === 'skill_role'
          ? (pack.assessmentPolicy.subQuota?.skill_role.exactlyPerDimension ?? 0)
          : (pack.assessmentPolicy.subQuota?.cooperation_behavior.minimumPerDimension ?? 0))
      dimensions.push({ layer, dimension: dimensionId, label, bankCount, perAssessment })
    }
  }

  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const inactiveCount = findings.filter((finding) => finding.severity === 'inactive').length
  const passed = findings.filter((finding) => finding.severity === 'pass').length

  return {
    packId: pack.id,
    packVersion: pack.version,
    scoringVersion: scoring.version,
    roleModelVersion: roleModel.version,
    counts: { questions: questions.length, errors, warnings, inactive: inactiveCount, passed },
    dimensions,
    samplerStages,
    findings,
    ok: errors === 0,
  }
}
