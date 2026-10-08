import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import { auditRoleModel, computeRoleFits } from '../../src/engine/role-fit.ts'
import type { DimensionResult, Layer } from '../../src/domain/schemas.ts'
import { fixtureRoleModel, fixtureScoringModel } from '../fixtures/packs.ts'

const bundle = loadContentBundle()

function dimension(
  id: string,
  layer: Layer,
  normalizedScore: number,
  overrides: Partial<DimensionResult> = {},
): DimensionResult {
  return {
    id,
    layer,
    label: id,
    rawScore: normalizedScore,
    normalizedScore,
    confidence: 1,
    answeredItems: 1,
    expectedItems: 1,
    maxPossible: 3,
    band: 'test',
    evidenceQuestionIds: [`${id}-q`],
    ...overrides,
  }
}

describe('role fit — layer A is structurally excluded (Engineering Bible §19)', () => {
  it('is unaffected by layer-A scores even at the extremes', () => {
    const base: DimensionResult[] = [
      dimension('b_one', 'cooperation_behavior', 50),
      dimension('c_one', 'skill_role', 50),
    ]
    const withLowA = computeRoleFits(
      fixtureRoleModel,
      [...base, dimension('a_one', 'theory_value', 0)],
      fixtureScoringModel,
    )
    const withHighA = computeRoleFits(
      fixtureRoleModel,
      [...base, dimension('a_one', 'theory_value', 100), dimension('a_two', 'theory_value', 100)],
      fixtureScoringModel,
    )
    expect(JSON.stringify(withLowA)).toBe(JSON.stringify(withHighA))
  })

  it('never lists a layer-A dimension as a contributing dimension', () => {
    const results = computeRoleFits(
      fixtureRoleModel,
      [
        dimension('a_one', 'theory_value', 100),
        dimension('b_one', 'cooperation_behavior', 40),
        dimension('b_two', 'cooperation_behavior', 60),
        dimension('c_one', 'skill_role', 80),
      ],
      fixtureScoringModel,
    )
    for (const result of results) {
      for (const contributing of result.contributingDimensions) {
        expect(contributing.startsWith('a_')).toBe(false)
      }
    }
  })

  it('proves the frozen role model contains no layer-A weight at all', () => {
    const audit = auditRoleModel(bundle.roleModel, bundle.scoring)
    expect(audit.layerAWeightViolations).toEqual([])
    expect(audit.unknownWeightViolations).toEqual([])
  })

  it('reports an unknown weight instead of silently ignoring it', () => {
    const tampered = {
      ...bundle.roleModel,
      roles: [{ id: 'x', name: 'X', weights: { no_such_dimension: 1 } }, ...bundle.roleModel.roles],
    }
    const audit = auditRoleModel(tampered, bundle.scoring)
    expect(audit.unknownWeightViolations.some((entry) => entry.startsWith('x:'))).toBe(true)
  })

  it('reports a layer-A weight if one is ever introduced', () => {
    // The dimension id comes from the active scoring model rather than being hard-coded, so this
    // keeps working across A-layer revisions (V1.0's four macro dimensions, V1.1's six).
    const layerADimension =
      Object.keys(bundle.scoring.layerA.dimensions)[0] ?? 'A0_declared_identity'
    const tampered = {
      ...bundle.roleModel,
      roles: [{ id: 'y', name: 'Y', weights: { [layerADimension]: 1 } }, ...bundle.roleModel.roles],
    }
    const audit = auditRoleModel(tampered, bundle.scoring)
    expect(audit.layerAWeightViolations).toEqual([`y:${layerADimension}`])
  })
})

describe('role fit — arithmetic', () => {
  it('weights only the dimensions that have evidence, renormalising over covered weight', () => {
    const results = computeRoleFits(
      fixtureRoleModel,
      [dimension('b_one', 'cooperation_behavior', 80)],
      fixtureScoringModel,
    )
    const alpha = results.find((result) => result.roleId === 'alpha')
    expect(alpha?.fitScore).toBe(80)
    expect(alpha?.coverage).toBe(1)

    // beta needs b_two (0.5) + c_one (0.5); with only b_two present the covered weight is 0.5 and
    // the score must be the renormalised b_two score, not a diluted half of it.
    const betaOnly = computeRoleFits(
      fixtureRoleModel,
      [dimension('b_two', 'cooperation_behavior', 60)],
      fixtureScoringModel,
    ).find((result) => result.roleId === 'beta')
    expect(betaOnly?.fitScore).toBe(60)
    expect(betaOnly?.coverage).toBe(0.5)
    expect(betaOnly?.missingDimensions).toEqual(['c_one'])
  })

  it('averages multiple covered dimensions by weight', () => {
    const gamma = computeRoleFits(
      fixtureRoleModel,
      [dimension('b_one', 'cooperation_behavior', 100), dimension('c_one', 'skill_role', 0)],
      fixtureScoringModel,
    ).find((result) => result.roleId === 'gamma')
    expect(gamma?.fitScore).toBe(50)
    expect(gamma?.coverage).toBe(1)
  })

  it('scores zero with zero coverage rather than pretending a fit exists', () => {
    const alpha = computeRoleFits(fixtureRoleModel, [], fixtureScoringModel).find(
      (result) => result.roleId === 'alpha',
    )
    expect(alpha?.fitScore).toBe(0)
    expect(alpha?.coverage).toBe(0)
    expect(alpha?.phrase).toContain('未覆盖')
  })

  it('orders results deterministically: score desc, coverage desc, role id asc', () => {
    const results = computeRoleFits(
      fixtureRoleModel,
      [
        dimension('b_one', 'cooperation_behavior', 50),
        dimension('b_two', 'cooperation_behavior', 50),
        dimension('c_one', 'skill_role', 50),
      ],
      fixtureScoringModel,
    )
    expect(results.map((result) => result.roleId)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('stays inside 0..100 with rounded integers', () => {
    for (let score = 0; score <= 100; score += 7) {
      const results = computeRoleFits(
        fixtureRoleModel,
        [
          dimension('b_one', 'cooperation_behavior', score),
          dimension('c_one', 'skill_role', score),
        ],
        fixtureScoringModel,
      )
      for (const result of results) {
        expect(Number.isInteger(result.fitScore)).toBe(true)
        expect(result.fitScore).toBeGreaterThanOrEqual(0)
        expect(result.fitScore).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe('role fit — output language (Engineering Bible §20, §24)', () => {
  it('uses the "current answers show" register, never "you are"', () => {
    const results = computeRoleFits(
      fixtureRoleModel,
      [dimension('b_one', 'cooperation_behavior', 70), dimension('c_one', 'skill_role', 70)],
      fixtureScoringModel,
    )
    for (const result of results) {
      expect(result.phrase).toContain('当前回答显示')
      expect(result.phrase).toContain('本次问卷条件下')
      expect(result.phrase).not.toContain('你就是')
      expect(result.phrase).toContain('不含理论层')
    }
  })

  it('masks a forbidden phrase if it ever reaches the output', () => {
    const tampered = {
      ...fixtureRoleModel,
      roles: [{ id: 'bad', name: '就是这种人', weights: { b_one: 1 } }],
    }
    const results = computeRoleFits(
      tampered,
      [dimension('b_one', 'cooperation_behavior', 70)],
      fixtureScoringModel,
    )
    expect(results[0]?.phrase).not.toContain('就是这种人')
    expect(results[0]?.phrase).toContain('[已按产品边界屏蔽]')
  })

  it('masks the extra boundary phrases the frozen role model omits (ADR-007)', () => {
    const tampered = {
      ...fixtureRoleModel,
      roles: [{ id: 'bad2', name: '危险人物', weights: { b_one: 1 } }],
    }
    const results = computeRoleFits(
      tampered,
      [dimension('b_one', 'cooperation_behavior', 70)],
      fixtureScoringModel,
    )
    expect(results[0]?.phrase).not.toContain('危险人物')
  })

  it('satisfies the frozen role model: every declared role gets a row', () => {
    const results = computeRoleFits(
      bundle.roleModel,
      [
        dimension('responsibility', 'cooperation_behavior', 60),
        dimension('research_skill', 'skill_role', 60),
      ],
      bundle.scoring,
    )
    expect(results).toHaveLength(bundle.roleModel.roles.length)
  })
})
