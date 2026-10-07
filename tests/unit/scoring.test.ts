import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import { scoreAssessment, ScoringError } from '../../src/engine/scoring.ts'
import { assessmentResultSchema, type AssessmentSession } from '../../src/domain/schemas.ts'

const bundle = loadContentBundle()
const { pack, scoring, roleModel } = bundle

const FIXED_TIME = '2026-10-07T12:00:00.000Z'

function buildSession(
  seed: string,
  style: 'balanced' | 'high' | 'low' = 'balanced',
): AssessmentSession {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `session_${seed}`,
    createdAt: FIXED_TIME,
  })
  const questions = paperQuestions(bundle, created.session)
  const answers = simulateAnswers(questions, seed, style)
  return { ...created.session, answers, status: 'completed', completedAt: FIXED_TIME }
}

function score(seed: string, style: 'balanced' | 'high' | 'low' = 'balanced') {
  return scoreAssessment({
    pack,
    scoring,
    roleModel,
    session: buildSession(seed, style),
    generatedAt: FIXED_TIME,
  })
}

describe('scoring — deterministic core (Engineering Bible §14, §50)', () => {
  it('produces byte-identical results for the same session', () => {
    const session = buildSession('det-1')
    const a = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
    const b = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not depend on answer insertion order', () => {
    const session = buildSession('det-2')
    const reversed: AssessmentSession = {
      ...session,
      answers: Object.fromEntries(Object.entries(session.answers).reverse()),
    }
    const a = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
    const b = scoreAssessment({
      pack,
      scoring,
      roleModel,
      session: reversed,
      generatedAt: FIXED_TIME,
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces the Structured Result schema exactly', () => {
    const result = score('schema-1')
    expect(assessmentResultSchema.safeParse(result).success).toBe(true)
    expect(result.versions.questionPack).toBe(`${pack.id}@${pack.version}`)
    expect(result.versions.scoring).toBe(`${scoring.id}@${scoring.version}`)
    expect(result.versions.roleModel).toBe(`${roleModel.id}@${roleModel.version}`)
  })

  it('never exposes a single total-score field anywhere in the result', () => {
    const result = score('no-total')
    // §16: no field named `total`, `overallScore`, `composite`, … may exist in the result tree.
    const forbiddenKeys = [
      'total',
      'totalScore',
      'overall',
      'overallScore',
      'composite',
      'compositeScore',
      'score',
    ]
    const seen: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          seen.push(key)
          walk(child)
        }
      }
    }
    walk(result)
    for (const key of forbiddenKeys) {
      expect(seen).not.toContain(key)
    }
    // The disclaimer must be present, which is the opposite of emitting a total.
    expect(result.limitations.join(' ')).toContain('系统不生成单一总分')
  })

  it('never calls an LLM: the result is a pure function of the session', () => {
    // §14: the scoring path performs no IO. A synchronous call that returns a fully populated
    // result is the observable proof available in a unit test.
    const result = score('no-llm')
    expect(result.dimensions.length).toBeGreaterThan(0)
    expect(typeof result.generatedAt).toBe('string')
  })
})

describe('scoring — normalization (Engineering Bible §15)', () => {
  it('matches the documented formula sum / maxPossible * 100', () => {
    for (const seed of ['norm-1', 'norm-2', 'norm-3']) {
      const session = buildSession(seed)
      const result = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
      for (const dimension of result.dimensions) {
        expect(dimension.maxPossible).toBeGreaterThan(0)
        const expected = Math.round((dimension.rawScore / dimension.maxPossible) * 100)
        expect(dimension.normalizedScore).toBe(expected)
      }
    }
  })

  it('gives every dimension 100 when the simulated respondent always picks the maximum', () => {
    const session = buildSession('all-high', 'high')
    const result = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
    for (const dimension of result.dimensions) {
      expect(dimension.normalizedScore).toBe(100)
      expect(dimension.band).toBe(scoring.interpretationBands.at(-1)?.label)
    }
  })

  it('is floored by the bank: 13 items have no zero-scoring option, so all-min cannot reach 0', () => {
    const session = buildSession('all-low', 'low')
    const result = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
    const nonZero = result.dimensions.filter((dimension) => dimension.normalizedScore > 0)
    expect(nonZero.length).toBeGreaterThan(0)
    for (const dimension of nonZero) {
      expect(dimension.rawScore).toBeGreaterThan(0)
    }
    for (const dimension of result.dimensions) {
      expect(dimension.normalizedScore).toBeLessThanOrEqual(100)
    }
  })

  it('keeps every normalized score inside 0..100 and rounds to integers', () => {
    for (let index = 0; index < 25; index += 1) {
      const result = score(`bounds-${index}`)
      for (const dimension of result.dimensions) {
        expect(Number.isInteger(dimension.normalizedScore)).toBe(true)
        expect(dimension.normalizedScore).toBeGreaterThanOrEqual(0)
        expect(dimension.normalizedScore).toBeLessThanOrEqual(100)
        expect(dimension.band.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('scoring — coverage, confidence and small-sample honesty', () => {
  it('flags every dimension measured by one or two items', () => {
    const result = score('small-sample')
    for (const dimension of result.dimensions) {
      if (dimension.answeredItems <= 2) {
        expect(dimension.warnings?.some((warning) => warning.includes('粒度过粗'))).toBe(true)
      }
    }
  })

  it('matches the ADR-008 expected-items definition per layer', () => {
    const result = score('expected-items')
    const expectedByDimension = new Map(result.dimensions.map((d) => [d.id, d.expectedItems]))
    // Layer A: declared subQuota maximum (4) after the rotating shortfall is applied.
    for (const dimension of [
      'conceptual_understanding',
      'theory_reality',
      'organizational_judgment',
    ]) {
      expect(expectedByDimension.get(dimension)).toBe(4)
    }
    // Layer B: declared minimum per dimension.
    for (const dimension of [
      'responsibility',
      'communication',
      'conflict_handling',
      'initiative',
      'reliability',
      'reflection',
    ]) {
      expect(expectedByDimension.get(dimension)).toBe(1)
    }
    // Layer C: declared exactly-one-per-dimension.
    for (const dimension of ['research_skill', 'execution_skill', 'coordination_skill']) {
      expect(expectedByDimension.get(dimension)).toBe(1)
    }
  })

  it('reduces confidence when items are left unanswered', () => {
    const session = buildSession('unanswered')
    const answered: AssessmentSession = { ...session }
    const firstThree = session.questionIds.slice(0, 3)
    const partial: AssessmentSession = {
      ...answered,
      answers: Object.fromEntries(
        Object.entries(answered.answers).filter(([questionId]) => !firstThree.includes(questionId)),
      ),
    }
    const full = scoreAssessment({ pack, scoring, roleModel, session, generatedAt: FIXED_TIME })
    const less = scoreAssessment({
      pack,
      scoring,
      roleModel,
      session: partial,
      generatedAt: FIXED_TIME,
    })
    const fullConfidence = full.dimensions.reduce((sum, d) => sum + d.confidence, 0)
    const lessConfidence = less.dimensions.reduce((sum, d) => sum + d.confidence, 0)
    expect(lessConfidence).toBeLessThan(fullConfidence)
    expect(less.evidence.length).toBeLessThan(full.evidence.length)
  })

  it('reports the coarse reachable score set for single-item dimensions', () => {
    const result = score('coarse')
    const single = result.dimensions.filter((dimension) => dimension.answeredItems === 1)
    expect(single.length).toBeGreaterThan(0)
    for (const dimension of single) {
      const warning = dimension.warnings?.find((entry) => entry.includes('归一化分数只能取'))
      expect(warning).toBeDefined()
    }
  })
})

describe('scoring — isolation and failure modes', () => {
  it('refuses to re-score with a different scoring version', () => {
    const session = buildSession('version-mismatch')
    expect(() =>
      scoreAssessment({
        pack,
        scoring,
        roleModel,
        session: { ...session, scoringVersion: '9.9.9' },
        generatedAt: FIXED_TIME,
      }),
    ).toThrow(ScoringError)
  })

  it('refuses to re-score with a different question pack version', () => {
    const session = buildSession('pack-mismatch')
    expect(() =>
      scoreAssessment({
        pack,
        scoring,
        roleModel,
        session: { ...session, questionPackVersion: '9.9.9' },
        generatedAt: FIXED_TIME,
      }),
    ).toThrow(ScoringError)
  })

  it('refuses a session that references a question outside the pack', () => {
    const session = buildSession('missing-question')
    expect(() =>
      scoreAssessment({
        pack,
        scoring,
        roleModel,
        session: { ...session, questionIds: [...session.questionIds, 'NOT_A_QUESTION'] },
        generatedAt: FIXED_TIME,
      }),
    ).toThrow(/不存在的题目/)
  })

  it('exposes the plan as a whole via completeAssessment', () => {
    const created = createAssessment({ bundle, seed: 'complete-path', sessionId: 'sess_complete' })
    const questions = paperQuestions(bundle, created.session)
    const answers = simulateAnswers(questions, 'complete-path')
    const { session, result } = completeAssessment(
      bundle,
      { ...created.session, answers },
      { generatedAt: FIXED_TIME },
    )
    expect(session.status).toBe('completed')
    expect(session.completedAt).toBe(FIXED_TIME)
    expect(result.sessionId).toBe('sess_complete')
    expect(result.samplerStages.length).toBeGreaterThan(0)
    expect(result.limitations.length).toBeGreaterThan(3)
    expect(result.strengths.length).toBe(3)
    expect(result.developmentAreas.length).toBe(3)
  })
})
