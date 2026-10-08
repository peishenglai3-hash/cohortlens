import {
  A_LAYER_DIMENSIONS,
  LAYERS,
  OPTION_ORDER_POLICIES,
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

  /**
   * A-layer V1.1 adds a second kind of scoring key: `knowledge_accuracy` questions score against a
   * *measurement* key (`theory_familiarity`) rather than repeating their own dimension id. Both are
   * legal; anything else is not.
   */
  const measurementKeys = new Set(['theory_familiarity'])
  const legalScoringKeys = new Set([...validDimensions, ...measurementKeys])

  check('illegal_scoring_key', () => {
    const bad: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        for (const key of Object.keys(option.scoring ?? {})) {
          if (!legalScoringKeys.has(key)) bad.push(`${question.id}/${option.id}:${key}`)
        }
      }
    }
    return bad.length === 0
      ? {
          severity: 'pass',
          code: 'illegal_scoring_key',
          message: `scoring 键全部合法（${validDimensions.size} 个维度键 + ${measurementKeys.size} 个测量键）。`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'illegal_scoring_key',
          message: `非法 scoring 键：${bad.slice(0, 20).join(', ')}`,
          subjects: bad,
        }
  })

  /**
   * A question whose options carry no numeric signal is **not** missing data once A-layer V1.1 is in
   * play: A0 is a categorical self-report and A2-A5 are descriptive evidence, and their empty
   * `scoring` maps are the mechanism by which the engine knows not to invent a number.
   *
   * So scoring is required unless the question declares itself descriptive — which it does by
   * putting `profileSignals` on its options instead.
   */
  const questionScoringIsOptional = (question: Question): boolean =>
    question.options.some((option) => option.profileSignals !== undefined) ||
    question.dimension === A_LAYER_DIMENSIONS.a0

  check('option_missing_scoring', () => {
    const bad: string[] = []
    const intentionallyUnscored: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        const signals = Object.values(option.scoring ?? {})
        if (signals.length > 0) continue
        if (questionScoringIsOptional(question)) intentionallyUnscored.push(question.id)
        else bad.push(`${question.id}/${option.id}`)
      }
    }
    if (bad.length > 0) {
      return {
        severity: 'error',
        code: 'option_missing_scoring',
        message: `缺少 scoring 的选项：${bad.slice(0, 20).join(', ')}`,
        subjects: bad,
      }
    }
    const distinct = [...new Set(intentionallyUnscored)]
    return {
      severity: 'pass',
      code: 'option_missing_scoring',
      message:
        distinct.length === 0
          ? '每个选项都带 scoring。'
          : `每个选项都带 scoring，或在 A 层按设计不参与数值计分（${distinct.length} 道：自我认同与描述性题目，空 scoring 是"不产生分数"的显式标记）。`,
      subjects: [],
    }
  })

  check('scoring_key_not_matching_own_dimension', () => {
    const bad: string[] = []
    const byMeasurementKey: string[] = []
    for (const question of questions) {
      for (const option of question.options) {
        const keys = Object.keys(option.scoring ?? {})
        if (keys.length > 1) bad.push(`${question.id}/${option.id}:multi(${keys.join('|')})`)
        const key = keys[0]
        if (key === undefined) continue
        if (key === question.dimension) continue
        if (measurementKeys.has(key) && question.scoringMode === 'knowledge_accuracy') {
          byMeasurementKey.push(`${question.id}:${key}`)
          continue
        }
        bad.push(`${question.id}/${option.id}:${key}`)
      }
    }
    if (bad.length > 0) {
      return {
        severity: 'error',
        code: 'scoring_key_not_matching_own_dimension',
        message: `信号维度与题目维度不一致：${bad.slice(0, 20).join(', ')}`,
        subjects: bad,
      }
    }
    return {
      severity: 'pass',
      code: 'scoring_key_not_matching_own_dimension',
      message:
        byMeasurementKey.length === 0
          ? '每题的选项只为一个维度打信号，且与题目 dimension 一致。'
          : `每题的选项只为一个键打信号；其中 ${byMeasurementKey.length} 个选项按 knowledge_accuracy 打在测量键 theory_familiarity 上（A1）。`,
      subjects: [],
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
    const descriptive: string[] = []
    for (const question of questions) {
      const raw = question.options.map((option) => Object.values(option.scoring ?? {})[0])
      /**
       * A question whose options all carry no numeric signal is a descriptive item, not a
       * degenerate one. A2-A5 report positions and patterns; calling them "no discrimination"
       * would be applying a scoring standard the author deliberately did not use.
       */
      if (raw.every((value) => value === undefined)) {
        descriptive.push(question.id)
        continue
      }
      const values = raw.map((value) => value ?? 0)
      if (new Set(values).size === 1) flat.push(question.id)
      if (Math.min(...values) > 0) floorAboveZero.push(`${question.id}(最低${Math.min(...values)})`)
      if (values.filter((value) => value === scoring.scale.maxPerQuestion).length === 1) {
        keyTransparent.push(question.id)
      }
    }
    const scoredQuestions = questions.length - descriptive.length
    const out: Finding[] = []
    out.push(
      flat.length === 0
        ? {
            severity: 'pass',
            code: 'degenerate_score_spread',
            message:
              descriptive.length === 0
                ? '每题至少有两个不同分值。'
                : `计分的 ${scoredQuestions} 道题每题至少有两个不同分值；另有 ${descriptive.length} 道题按设计不参与数值计分（自我认同与描述性题目）。`,
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
      keyTransparent.length === scoredQuestions && scoredQuestions > 0
        ? {
            severity: 'warning',
            code: 'transparent_single_key',
            message: `计分的 ${scoredQuestions} 道题全部恰好只有一个选项取到满分 ${scoring.scale.maxPerQuestion}，其余选项均 <= 1：表面效度上"只有一个明显好答案"。这是题库作者已知的设计取舍（源 README 第 76-83 行），依赖 optionShuffle 与跨题一致性缓解，不能当作已解决的测量问题。`,
            subjects: [],
          }
        : {
            severity: 'pass',
            code: 'transparent_single_key',
            message: `计分的 ${scoredQuestions} 道题中有 ${scoredQuestions - keyTransparent.length} 道有部分给分梯度。`,
            subjects: [],
          },
    )
    if (descriptive.length > 0) {
      out.push({
        severity: 'pass',
        code: 'descriptive_items_not_scored',
        message: `${descriptive.length} 道 A 层题目按设计不产生数值分数（A0 自我认同 / A2–A5 描述性证据）：${descriptive.slice(0, 12).join(', ')}${descriptive.length > 12 ? ' …' : ''}`,
        subjects: [],
      })
    }
    return out
  })

  check('key_position_tell', () => {
    const positions = new Map<string, number>()
    let scored = 0
    for (const question of questions) {
      /**
       * Only questions that actually have a "full mark" participate. A descriptive A-layer item has
       * no scored options at all, so treating its position 0 as a keyed answer would invent a tell
       * that does not exist and dilute the real distribution.
       */
      const values = question.options.map((option) => Object.values(option.scoring ?? {})[0])
      if (values.every((value) => value === undefined)) continue
      const numeric = values.map((value) => value ?? 0)
      const index = numeric.indexOf(scoring.scale.maxPerQuestion)
      if (index < 0) continue
      scored += 1
      const label = String.fromCharCode(65 + index)
      positions.set(label, (positions.get(label) ?? 0) + 1)
    }
    const summary = [...positions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
    const top = [...positions.entries()].sort((a, b) => b[1] - a[1])[0]
    const share = top && scored > 0 ? top[1] / scored : 0
    return share > 0.5
      ? {
          severity: 'warning',
          code: 'key_position_tell',
          message: `在 ${scored} 道计分题中，满分选项的位置分布高度不均（${summary.join(', ')}，最高位占 ${(share * 100).toFixed(1)}%）。运行时必须按题目策略处理选项顺序，且人工审阅版题库（md）会直接暴露答案位置。`,
          subjects: [],
        }
      : {
          severity: 'pass',
          code: 'key_position_tell',
          message: `在 ${scored} 道计分题中，满分选项位置分布：${summary.join(', ')}`,
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
    /**
     * The rule is now **per dimension**, not per paper.
     *
     * A-layer V1.1 deliberately groups the items of one sub-topic under a shared `familyId` (all
     * eight A0 items are four families of two). A paper-wide "no family twice" rule would make A0's
     * quota of two impossible; the engine therefore caps how many items one dimension may take from
     * a single family at `ceil(need / distinctFamilies)`. The validator checks the same rule, which
     * is what actually has to hold.
     */
    const perDimension = new Map<string, Map<string, number>>()
    for (const question of questions) {
      if (!question.familyId) continue
      const byFamily = perDimension.get(question.dimension) ?? new Map<string, number>()
      byFamily.set(question.familyId, (byFamily.get(question.familyId) ?? 0) + 1)
      perDimension.set(question.dimension, byFamily)
    }

    /**
     * The cap the engine actually enforces, which is deliberately the **strictest** rule the bank
     * can satisfy: never draw the same `familyId` twice inside one dimension.
     *
     * The A-layer quota is small (2 or 3 per dimension) and every dimension has at least four
     * distinct families, so "at most one per family" is always achievable, and it is the reading
     * that best matches the intent of `avoidSameFamily` — a dimension should not lean on one
     * sub-topic. The validator checks that this stricter rule remains satisfiable, so a future pack
     * cannot shrink a dimension's family pool below its quota without the check failing.
     */
    const subQuotaA = pack.assessmentPolicy.subQuota?.theory_value ?? {}
    const familyCountPerDimension = new Map<string, number>()
    for (const [dimension, bank] of banksByDimension) {
      const families = new Set(
        bank.map((question) => question.familyId).filter((id): id is string => Boolean(id)),
      )
      familyCountPerDimension.set(dimension, families.size || 1)
    }

    const overfull: string[] = []
    for (const dimension of new Set(questions.map((question) => question.dimension))) {
      const need = subQuotaA[dimension] ?? 1
      const familyCount = familyCountPerDimension.get(dimension) ?? 1
      if (need > familyCount) {
        overfull.push(
          `${dimension}(需 ${need} 题但只有 ${familyCount} 个 family，无法做到每族仅取一次)`,
        )
      }
    }

    return overfull.length === 0
      ? {
          severity: 'pass',
          code: 'family_conflict',
          message: `${conflicting.length} 个 family 含多题；抽样按"同一维度内每个 familyId 只取一次"限制，各维 family 数均足以满足配额。`,
          subjects: conflicting.map(([familyId]) => familyId),
        }
      : {
          severity: 'error',
          code: 'family_conflict',
          message: `以下维度无法满足"同一维度内每族只取一次"，可能凑不满配额：${overfull.join('；')}`,
          subjects: overfull,
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

  // --- A-layer V1.1 structural rules ---------------------------------------
  // These encode the migration requirements directly, so a future pack cannot quietly drop one:
  // strict per-dimension A quota, A0 as self-report only, balanced A1 answer positions, option
  // ordering that respects the declared policy, and the removal of the stale CG05-CG08 mappings.

  check('a_layer_quota_shape', () => {
    const sub = pack.assessmentPolicy.subQuota?.theory_value
    const declared = Object.keys(scoring.layerA.dimensions)
    if (!sub) {
      return {
        severity: 'inactive',
        code: 'a_layer_quota_shape',
        message: '题库未声明 A 层 subQuota，跳过 A 层配额形状检查。',
        subjects: [],
      }
    }
    const problems: string[] = []
    for (const dimension of declared) {
      const need = sub[dimension]
      if (need === undefined) {
        problems.push(`维度 ${dimension} 未声明单次配额`)
        continue
      }
      const pool = banksByDimension.get(dimension)?.length ?? 0
      if (pool === 0) problems.push(`维度 ${dimension} 在题库中没有题目`)
      else if (pool < need) problems.push(`维度 ${dimension} 需要 ${need} 题，题库只有 ${pool} 题`)
    }
    const unexpected = Object.keys(sub).filter((dimension) => !declared.includes(dimension))
    if (unexpected.length > 0) {
      problems.push(`subQuota 声明了评分模型未定义的维度：${unexpected.join(', ')}`)
    }
    const total = Object.values(sub).reduce((a, b) => a + b, 0)
    if (total !== (pack.assessmentPolicy.quota.theory_value ?? 0)) {
      problems.push(
        `A 层每维配额之和 ${total} != A 层配额 ${pack.assessmentPolicy.quota.theory_value}`,
      )
    }
    return problems.length === 0
      ? {
          severity: 'pass',
          code: 'a_layer_quota_shape',
          message: `A 层 ${declared.length} 个维度配额形状正确：${declared
            .map((dimension) => `${dimension}=${sub[dimension]}`)
            .join(' ')}（合计 ${total}）`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'a_layer_quota_shape',
          message: `A 层配额形状有问题：${problems.join('；')}`,
          subjects: problems,
        }
  })

  check('a0_self_report_only', () => {
    const a0 = questions.filter((question) => question.dimension === A_LAYER_DIMENSIONS.a0)
    if (a0.length === 0) {
      return {
        severity: 'inactive',
        code: 'a0_self_report_only',
        message: '题库没有 A0 自我认同题目，跳过自我申报检查。',
        subjects: [],
      }
    }
    const problems: string[] = []
    for (const question of a0) {
      if (question.scenarioType !== 'self_report') {
        problems.push(
          `${question.id} 的 scenarioType 是 ${question.scenarioType}，应为 self_report`,
        )
      }
      for (const option of question.options) {
        if (option.selfReportCategory === undefined) {
          problems.push(`${question.id}/${option.id} 缺少 selfReportCategory`)
        }
        if (Object.keys(option.scoring ?? {}).length > 0) {
          problems.push(`${question.id}/${option.id} 带 scoring，A0 不参与数值计分`)
        }
      }
      const categories = question.options
        .map((option) => option.selfReportCategory)
        .filter((value): value is string => value !== undefined)
      if (new Set(categories).size !== categories.length) {
        problems.push(`${question.id} 的 selfReportCategory 有重复`)
      }
    }
    return problems.length === 0
      ? {
          severity: 'pass',
          code: 'a0_self_report_only',
          message: `A0 共 ${a0.length} 题，全部为 self_report、全部带唯一 selfReportCategory、全部不参与数值计分。`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'a0_self_report_only',
          message: `A0 自我申报规则被破坏：${problems.slice(0, 10).join('；')}`,
          subjects: problems,
        }
  })

  check('a1_answer_position_balance', () => {
    const a1 = questions.filter(
      (question) =>
        question.layer === 'theory_value' && question.scoringMode === 'knowledge_accuracy',
    )
    if (a1.length === 0) {
      return {
        severity: 'inactive',
        code: 'a1_answer_position_balance',
        message: '题库没有 knowledge_accuracy 题目，跳过正确答案位置检查。',
        subjects: [],
      }
    }
    const positions = new Map<string, number>()
    const problems: string[] = []
    for (const question of a1) {
      const values = question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)
      const best = Math.max(...values)
      const bestIndexes = values
        .map((value, index) => (value === best ? index : -1))
        .filter((index) => index >= 0)
      if (bestIndexes.length !== 1) {
        problems.push(`${question.id} 的正确答案不是唯一（${bestIndexes.length} 个满分选项）`)
        continue
      }
      const label = String.fromCharCode(65 + (bestIndexes[0] ?? 0))
      positions.set(label, (positions.get(label) ?? 0) + 1)
    }
    if (problems.length > 0) {
      return {
        severity: 'error',
        code: 'a1_answer_position_balance',
        message: problems.join('；'),
        subjects: problems,
      }
    }
    const spread = [...positions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const ideal = a1.length / 4
    const unbalanced = spread.some(
      ([, count]) => Math.abs(count - ideal) > Math.max(1, ideal * 0.5),
    )
    return unbalanced
      ? {
          severity: 'warning',
          code: 'a1_answer_position_balance',
          message: `A1 正确答案位置分布不均：${spread
            .map(([label, count]) => `${label}=${count}`)
            .join(
              ' ',
            )}（共 ${a1.length} 题，理想每位置 ${ideal}）。位置打乱可缓解，但建议人工平衡。`,
          subjects: [],
        }
      : {
          severity: 'pass',
          code: 'a1_answer_position_balance',
          message: `A1 正确答案位置分布：${spread
            .map(([label, count]) => `${label}=${count}`)
            .join(' ')}（共 ${a1.length} 题）`,
          subjects: [],
        }
  })

  check('option_order_policy_respected', () => {
    const problems: string[] = []
    const counts = new Map<string, number>()
    for (const question of questions) {
      const raw = question.metadata?.optionOrderPolicy
      const policy = raw === undefined ? 'shuffle(default)' : String(raw)
      counts.set(policy, (counts.get(policy) ?? 0) + 1)
      if (raw !== undefined && !OPTION_ORDER_POLICIES.includes(raw as never)) {
        problems.push(`${question.id} 的 optionOrderPolicy 非法：${String(raw)}`)
      }
      if (
        raw === 'preserve_or_reverse' &&
        question.layer === 'theory_value' &&
        pack.assessmentPolicy.sampling?.optionShuffle === true
      ) {
        problems.push(`${question.id} 需要保序/整体反转，但题库级 optionShuffle=true 会打乱它`)
      }
    }
    return problems.length === 0
      ? {
          severity: 'pass',
          code: 'option_order_policy_respected',
          message: `选项顺序策略合法：${[...counts.entries()]
            .map(([policy, count]) => `${policy}=${count}`)
            .join(' ')}`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'option_order_policy_respected',
          message: `选项顺序策略有问题：${problems.slice(0, 10).join('；')}`,
          subjects: problems,
        }
  })

  check('stale_a_consistency_groups_removed', () => {
    const stale = scoring.confidence.consistencyGroups
      .filter((group) =>
        group.questions.some((questionId) => {
          const question = questionById.get(questionId)
          return question?.layer === 'theory_value'
        }),
      )
      .map((group) => group.id)
    const removed = ['CG05', 'CG06', 'CG07', 'CG08'].filter(
      (id) => !scoring.confidence.consistencyGroups.some((group) => group.id === id),
    )
    if (stale.length > 0) {
      return {
        severity: 'error',
        code: 'stale_a_consistency_groups_removed',
        message: `以下一致性组仍引用 A 层题目，V1.1 后这些语义映射已失效：${stale.join(', ')}。A001 等 ID 被复用于新题，沿用旧映射会把新题按旧语义比较。`,
        subjects: stale,
      }
    }
    return {
      severity: 'pass',
      code: 'stale_a_consistency_groups_removed',
      message:
        removed.length > 0
          ? `一致性组不含 A 层题目（已移除旧映射：${removed.join(', ')}）。`
          : '一致性组不含 A 层题目。',
      subjects: [],
    }
  })

  check('a_layer_boundary_text', () => {
    const aLayerQuestions = questions.filter((question) => question.layer === 'theory_value')
    if (aLayerQuestions.length === 0) {
      return {
        severity: 'inactive',
        code: 'a_layer_boundary_text',
        message: '题库没有 A 层题目，跳过 A 层措辞扫描。',
        subjects: [],
      }
    }
    const declared = new Set([
      ...(roleModel.forbiddenLanguage ?? []),
      ...REQUIRED_FORBIDDEN_LANGUAGE,
    ])
    const hits: string[] = []
    for (const question of aLayerQuestions) {
      const haystack = [question.prompt, ...question.options.map((option) => option.text)].join(
        '\n',
      )
      for (const phrase of declared) {
        if (haystack.includes(phrase)) hits.push(`${question.id}:${phrase}`)
      }
    }
    return hits.length === 0
      ? {
          severity: 'pass',
          code: 'a_layer_boundary_text',
          message: `A 层 ${aLayerQuestions.length} 题的题干与选项未出现任何禁用输出语。`,
          subjects: [],
        }
      : {
          severity: 'warning',
          code: 'a_layer_boundary_text',
          message: `A 层题干或选项出现禁用输出语（需人工确认是"讨论对象"还是"评价他人"）：${hits
            .slice(0, 20)
            .join(', ')}`,
          subjects: hits,
        }
  })

  check('a_layer_scoring_policy_consistency', () => {
    const policy = scoring.layerAProfilePolicy
    const aLayerDimensions = Object.keys(scoring.layerA.dimensions)
    const isV11 = aLayerDimensions.includes(A_LAYER_DIMENSIONS.a0)
    if (!isV11) {
      return {
        severity: 'inactive',
        code: 'a_layer_scoring_policy_consistency',
        message: '当前评分模型的 A 层不是 V1.1 六维结构，跳过 A 层呈现政策检查。',
        subjects: [],
      }
    }
    const problems: string[] = []
    if (!policy) problems.push('scoring-v1.1 缺少 layerAProfilePolicy')
    else {
      for (const dimension of aLayerDimensions) {
        if (policy.displayPolicy[dimension] === undefined) {
          problems.push(`layerAProfilePolicy.displayPolicy 未覆盖维度 ${dimension}`)
        }
      }
      if (policy.exploratorySignals.userFacingByDefault) {
        problems.push(
          'exploratorySignals.userFacingByDefault 为 true，会把探索性轴信号直接呈现给用户',
        )
      }
      if (policy.forbiddenOutputs.length === 0) problems.push('forbiddenOutputs 为空')
    }
    if (scoring.layerA.useInRoleFit) problems.push('layerA.useInRoleFit 为 true')
    if (scoring.layerA.useForAdmissionDecision) {
      problems.push('layerA.useForAdmissionDecision 为 true')
    }
    if (scoring.layerA.aggregateTotalScore !== false) {
      problems.push('layerA.aggregateTotalScore 不是 false，A 层可能被求和')
    }
    return problems.length === 0
      ? {
          severity: 'pass',
          code: 'a_layer_scoring_policy_consistency',
          message: `A 层呈现政策自洽：${aLayerDimensions.length} 维均有 displayPolicy，探索性信号不面向用户，禁止输出清单 ${policy?.forbiddenOutputs.length ?? 0} 条，不进入 role-fit，不生成总分。`,
          subjects: [],
        }
      : {
          severity: 'error',
          code: 'a_layer_scoring_policy_consistency',
          message: `A 层呈现政策有问题：${problems.join('；')}`,
          subjects: problems,
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
