import { REQUIRED_FORBIDDEN_LANGUAGE } from '../domain/validation.ts'
import {
  roleWeightMap,
  type DimensionResult,
  type RoleFitResult,
  type RoleModel,
  type ScoringModel,
} from '../domain/schemas.ts'

/**
 * Role Fit Engine — Engineering Bible §19/§20.
 *
 * Only layer B (cooperation_behavior) and layer C (skill_role) dimensions may be used.
 * Layer A dimensions are excluded structurally, not by convention: this function never sees
 * them, because `computeRoleFits` filters them out before weighting. §19 forbids using political
 * tendency to assign organisational roles, and A layer is the only layer that carries
 * theory/values content.
 *
 * The output language is fixed by §20 and by the role model's own `outputLanguage` list:
 * "当前回答显示…", never "你就是…".
 */

export interface RoleFitOptions {
  /** Extra phrases to refuse in generated role text. Merged with the role model's list. */
  extraForbiddenLanguage?: readonly string[]
}

export interface RoleFitAudit {
  /** Role ids whose weight map referenced a layer-A dimension (must always be empty). */
  layerAWeightViolations: string[]
  /** Role ids whose weight map referenced a dimension that does not exist in the scoring model. */
  unknownWeightViolations: string[]
}

/**
 * Static audit of the role model against the scoring model. Exported so the validator and the
 * tests can prove that layer A never leaks into role fit, rather than trusting the data.
 */
export function auditRoleModel(roleModel: RoleModel, scoring: ScoringModel): RoleFitAudit {
  const layerADimensions = new Set(Object.keys(scoring.layerA.dimensions))
  const knownDimensions = new Set([
    ...Object.keys(scoring.layerA.dimensions),
    ...Object.keys(scoring.layerB.dimensions),
    ...Object.keys(scoring.layerC.dimensions),
  ])
  const layerAWeightViolations: string[] = []
  const unknownWeightViolations: string[] = []

  for (const role of roleModel.roles) {
    for (const dimension of Object.keys(roleWeightMap(role))) {
      if (layerADimensions.has(dimension)) layerAWeightViolations.push(`${role.id}:${dimension}`)
      if (!knownDimensions.has(dimension)) unknownWeightViolations.push(`${role.id}:${dimension}`)
    }
  }
  return { layerAWeightViolations, unknownWeightViolations }
}

function sanitise(text: string, forbidden: readonly string[]): string {
  let output = text
  for (const phrase of forbidden) {
    if (output.includes(phrase)) output = output.split(phrase).join('[已按产品边界屏蔽]')
  }
  return output
}

/**
 * @param scoringModel accepted for symmetry with the validator and to document that role fit is
 *        evaluated against a specific scoring model version. Role weights are validated by
 *        `auditRoleModel` before this function runs, so the parameter itself is not read here;
 *        `dimensions` already carries the layer of every row, which is what the exclusion needs.
 */
export function computeRoleFits(
  roleModel: RoleModel,
  dimensions: readonly DimensionResult[],
  scoringModel: ScoringModel,
  options: RoleFitOptions = {},
): RoleFitResult[] {
  void scoringModel
  // Structural exclusion of layer A (Engineering Bible §19, source README line 53).
  const eligible = dimensions.filter(
    (dimension) => dimension.layer === 'cooperation_behavior' || dimension.layer === 'skill_role',
  )
  if (eligible.some((dimension) => dimension.layer === 'theory_value')) {
    // Defensive: unreachable, but the invariant is worth asserting rather than assuming.
    throw new Error('角色适配收到了 A 层维度，违反 Engineering Bible §19')
  }

  const scoreById = new Map(eligible.map((dimension) => [dimension.id, dimension]))
  const forbidden = [
    ...(roleModel.forbiddenLanguage ?? []),
    ...REQUIRED_FORBIDDEN_LANGUAGE,
    ...(options.extraForbiddenLanguage ?? []),
  ]
  const phrases = roleModel.outputLanguage ?? ['当前回答显示']

  const results: RoleFitResult[] = roleModel.roles.map((role, index) => {
    const weights = roleWeightMap(role)
    const entries = Object.entries(weights).filter(([dimension]) => scoreById.has(dimension))
    const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0)
    const coveredWeight = entries.reduce((sum, [, weight]) => sum + weight, 0)

    const weighted =
      coveredWeight > 0
        ? entries.reduce(
            (sum, [dimension, weight]) =>
              sum + (scoreById.get(dimension)?.normalizedScore ?? 0) * weight,
            0,
          ) / coveredWeight
        : 0

    const fitScore = Math.round(weighted)
    const coverage = totalWeight > 0 ? coveredWeight / totalWeight : 0
    const contributing = entries.map(([dimension]) => dimension)
    const missing = Object.keys(weights).filter((dimension) => !scoreById.has(dimension))

    const phrase = phrases[index % phrases.length] ?? '当前回答显示'
    const detail = sanitise(
      `在本次问卷条件下，${phrase}「${role.name}」的相关维度较可能适合：${contributing
        .map((dimension) => {
          const row = scoreById.get(dimension)
          return `${row?.label ?? dimension} ${row?.normalizedScore ?? 0}`
        })
        .join('、')}。该分数只由合作与技能层维度加权得到，不含理论层；权重覆盖率 ${(
        coverage * 100
      ).toFixed(0)}%${missing.length > 0 ? `，本次问卷未覆盖 ${missing.join('、')}` : ''}。`,
      forbidden,
    )

    return {
      roleId: role.id,
      name: role.name,
      fitScore,
      coverage,
      contributingDimensions: contributing,
      missingDimensions: missing,
      phrase: detail,
    }
  })

  // Deterministic ordering: fit desc, then coverage desc, then role id asc.
  return results.sort(
    (a, b) =>
      b.fitScore - a.fitScore ||
      b.coverage - a.coverage ||
      (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0),
  )
}
