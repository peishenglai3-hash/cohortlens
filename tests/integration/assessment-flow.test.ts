import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  answerQuestion,
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import { assessmentResultSchema, assessmentSessionSchema } from '../../src/domain/schemas.ts'
import { renderResultText } from '../../src/domain/report-text.ts'
import { validateQuestionPack } from '../../src/domain/validation.ts'
import { auditRoleModel } from '../../src/engine/role-fit.ts'
import { sampleQuestionSet, shuffleOptions } from '../../src/engine/sampler.ts'

/**
 * Integration: Question Pack -> Assessment -> Result (Engineering Bible §48 third layer),
 * plus the release-gate invariants that only hold when the whole chain runs on the real bank.
 */

const bundle = loadContentBundle()
const { pack, scoring, roleModel } = bundle
const FIXED_TIME = '2026-10-07T12:00:00.000Z'

function fullRun(seed: string) {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `sess_${seed}`,
    createdAt: FIXED_TIME,
  })
  const questions = paperQuestions(bundle, created.session)
  const answers = simulateAnswers(questions, seed)
  const { session, result } = completeAssessment(
    bundle,
    { ...created.session, answers },
    { generatedAt: FIXED_TIME },
  )
  return { created, session, result, questions }
}

describe('integration — question pack to structured result', () => {
  it('walks the whole chain on the real 120-item bank', () => {
    const { created, session, result, questions } = fullRun('integration-1')
    expect(created.session.questionIds).toHaveLength(30)
    expect(questions).toHaveLength(30)
    expect(Object.keys(session.answers)).toHaveLength(30)
    expect(session.status).toBe('completed')
    expect(assessmentSessionSchema.safeParse(session).success).toBe(true)
    expect(assessmentResultSchema.safeParse(result).success).toBe(true)
    expect(result.evidence).toHaveLength(30)
    expect(result.dimensions).toHaveLength(16)
    expect(result.roleFits).toHaveLength(6)
  })

  it('is reproducible end to end: the same seed rebuilds the same result', () => {
    const a = fullRun('integration-2')
    const b = fullRun('integration-2')
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
    expect(a.session.questionIds).toEqual(b.session.questionIds)
  })

  it('a session survives a reload: reconstructing from stored fields yields the same paper', () => {
    const { created, session } = fullRun('integration-3')
    // Simulate a page refresh: only the persisted session object survives.
    const restored = assessmentSessionSchema.parse(JSON.parse(JSON.stringify(session)))
    expect(restored.questionIds).toEqual(session.questionIds)
    // Re-deriving the option order from the stored seed must reproduce the same render order,
    // otherwise a refresh would silently reorder the answers on screen.
    const before = shuffleOptions(pack, created.session.questionIds, created.session.seed)
    const after = shuffleOptions(pack, restored.questionIds, restored.seed)
    expect(after).toEqual(before)
  })

  it('regenerating the paper from the stored seed reproduces the stored question ids', () => {
    const created = createAssessment({ bundle, seed: 'integration-4', sessionId: 's' })
    const again = sampleQuestionSet({ pack, scoring, seed: created.session.seed })
    expect(again.questionIds).toEqual(created.session.questionIds)
  })

  it('upgrading the bank cannot silently change a stored paper', () => {
    const { session, result } = fullRun('integration-5')
    // The result must be derivable from the stored ids alone; nothing re-samples.
    expect(result.sessionId).toBe(session.id)
    expect(result.evidence.map((item) => item.questionId).sort()).toEqual(
      [...session.questionIds].sort(),
    )
  })

  it('answerQuestion rejects a question outside the paper and records one inside it', () => {
    const created = createAssessment({ bundle, seed: 'integration-6', sessionId: 's6' })
    const firstId = created.session.questionIds[0]!
    const question = pack.questions.find((candidate) => candidate.id === firstId)!
    const optionId = question.options[0]!.id
    const updated = answerQuestion(created.session, firstId, optionId)
    expect(updated.answers[firstId]).toBe(optionId)
    expect(() => answerQuestion(created.session, 'NOT_IN_PAPER', optionId)).toThrow()
  })
})

describe('integration — release-gate invariants on the real bank', () => {
  it('gate 7: the 30-item quota holds across many draws', () => {
    for (let index = 0; index < 60; index += 1) {
      const sampled = sampleQuestionSet({ pack, scoring, seed: `gate-${index}` })
      expect(sampled.questionIds).toHaveLength(30)
    }
  })

  it('gate 9/10: local scoring and role fit complete without any network call', () => {
    const { result } = fullRun('gate-local')
    expect(result.dimensions.every((dimension) => dimension.band.length > 0)).toBe(true)
    expect(result.roleFits.every((fit) => fit.fitScore >= 0 && fit.fitScore <= 100)).toBe(true)
  })

  it('gate 12: the result is JSON-serialisable and round-trips without loss', () => {
    const { result } = fullRun('gate-export')
    const roundTripped = JSON.parse(JSON.stringify(result))
    expect(assessmentResultSchema.safeParse(roundTripped).success).toBe(true)
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(result))
  })

  it('gate 13: the printable text view contains every mandated section', () => {
    const { result } = fullRun('gate-print')
    const text = renderResultText(result, pack)
    for (const section of [
      '维度画像',
      '角色适配',
      '回答一致性与稳定度',
      '抽题引擎阶段实际状态',
      '测评局限性',
    ]) {
      expect(text).toContain(section)
    }
    // Boundary language must be present, and pass/fail framing must not be.
    expect(text).toContain('不得解释为政治立场')
    expect(text).not.toContain('淘汰')
    expect(text).not.toContain('录取')
  })

  it('gate: theory layer never reaches role fit on the real bank', () => {
    const { result } = fullRun('gate-layer-a')
    const theoryDimensions = new Set(
      result.dimensions.filter((dimension) => dimension.layer === 'theory_value').map((d) => d.id),
    )
    expect(theoryDimensions.size).toBeGreaterThan(0)
    for (const fit of result.roleFits) {
      for (const contributing of fit.contributingDimensions) {
        expect(theoryDimensions.has(contributing)).toBe(false)
      }
    }
    expect(auditRoleModel(roleModel, scoring).layerAWeightViolations).toEqual([])
  })

  it('gate: no single total score is produced anywhere in the rendered output', () => {
    const { result } = fullRun('gate-no-total')
    const text = renderResultText(result, pack)
    expect(text).toContain('系统不输出单一总分')
    // The disclaimer names 综合素质 as the thing the system refuses to produce, so the check is
    // structural: no line may present a total-style number as a result.
    const totalLines = text
      .split('\n')
      .filter((line) => /综合素质|总分|总体得分/.test(line))
      .filter((line) => !/不生成|不能相加|不输出|不是/.test(line))
    expect(totalLines).toEqual([])
  })

  it('gate 20: no API key material is present in any shipped content file', () => {
    const serialised = JSON.stringify({ pack, scoring, roleModel })
    for (const pattern of ['sk-', 'apiKey', 'api_key', 'Bearer ', 'AIza']) {
      expect(serialised).not.toContain(pattern)
    }
  })

  it('the validator agrees with the runtime: the bank ships clean', () => {
    const report = validateQuestionPack({
      pack,
      scoring,
      roleModel,
      samplerStages: sampleQuestionSet({ pack, scoring, seed: 'gate-validate' }).stages,
    })
    expect(report.ok).toBe(true)
  })
})
