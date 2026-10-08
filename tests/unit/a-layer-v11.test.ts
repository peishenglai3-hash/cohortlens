import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import { A_LAYER_DIMENSIONS } from '../../src/domain/schemas.ts'
import { sampleQuestionSet, shuffleOptions, resolveOptionOrder } from '../../src/engine/sampler.ts'
import { scoreAssessment } from '../../src/engine/scoring.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import { validateQuestionPack } from '../../src/domain/validation.ts'
import { renderResultText } from '../../src/domain/report-text.ts'
import { buildReportPayload } from '../../src/infrastructure/ai/report-payload.ts'
import {
  buildReportPrompt,
  MANDATED_SECTIONS_ZH,
  REPORT_PROMPT_VERSION,
} from '../../src/infrastructure/ai/prompts/report-prompt.ts'

/**
 * A-layer V1.1 — the measurement model the client replaced.
 *
 * The DSH migration pack lists the tests this round must add, and each one is a claim about what the
 * system is now allowed to do:
 *
 *   1. every draw is strictly 2/3/3/3/2/2 across the six A dimensions;
 *   2. A0 never enters a numeric total;
 *   3. the A layer never reaches role-fit;
 *   4. consistency groups CG05-CG08 are gone;
 *   5. A1's correct answers are balanced A/B/C/D across the item bank;
 *   6. A2/A3 option order cannot be broken by plain shuffling;
 *   7. V1.0 and V1.1 sessions cannot be scored across pack versions.
 *
 * The whole file is written so that a future A-layer revision fails loudly here rather than quietly
 * loosening one of these guarantees.
 */

const bundle = loadContentBundle()
const { pack, scoring, roleModel } = bundle
const A_DIMS = Object.values(A_LAYER_DIMENSIONS)
const byId = new Map(pack.questions.map((question) => [question.id, question]))

const FIXED_TIME = '2026-10-08T12:00:00.000Z'

function run(seed: string) {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `sess_${seed}`,
    createdAt: FIXED_TIME,
  })
  const answers = simulateAnswers(paperQuestions(bundle, created.session), seed)
  return completeAssessment(bundle, { ...created.session, answers }, { generatedAt: FIXED_TIME })
}

describe('rule 1 — the A-layer quota is exactly 2/3/3/3/2/2', () => {
  const declared = pack.assessmentPolicy.subQuota?.theory_value ?? {}

  it('declares the six A dimensions with the client-specified split', () => {
    expect(Object.keys(scoring.layerA.dimensions)).toEqual(A_DIMS)
    expect(declared).toEqual({
      A0_declared_identity: 2,
      A1_theory_structure: 3,
      A2_political_economy: 3,
      A3_social_political: 3,
      A4_practice_orientation: 2,
      A5_reflexivity: 2,
    })
    expect(Object.values(declared).reduce((a, b) => a + b, 0)).toBe(15)
  })

  it('honours that split on every one of 400 draws', () => {
    for (let index = 0; index < 400; index += 1) {
      const sampled = sampleQuestionSet({ pack, scoring, seed: `a-quota-${index}` })
      const counts: Record<string, number> = {}
      for (const questionId of sampled.questionIds) {
        const question = byId.get(questionId)
        if (question?.layer !== 'theory_value') continue
        counts[question.dimension] = (counts[question.dimension] ?? 0) + 1
      }
      expect(counts, `seed a-quota-${index}`).toEqual(declared)
      expect(sampled.questionIds).toHaveLength(30)
    }
  })

  it('keeps the whole paper at 15 / 9 / 6', () => {
    for (let index = 0; index < 50; index += 1) {
      const sampled = sampleQuestionSet({ pack, scoring, seed: `a-layers-${index}` })
      const layers = { theory_value: 0, cooperation_behavior: 0, skill_role: 0 }
      for (const questionId of sampled.questionIds) {
        const question = byId.get(questionId)
        if (question) layers[question.layer] += 1
      }
      expect(layers).toEqual({ theory_value: 15, cooperation_behavior: 9, skill_role: 6 })
    }
  })

  it('never draws the same family twice inside one A dimension', () => {
    for (let index = 0; index < 200; index += 1) {
      const sampled = sampleQuestionSet({ pack, scoring, seed: `a-family-${index}` })
      const perDimension = new Map<string, string[]>()
      for (const questionId of sampled.questionIds) {
        const question = byId.get(questionId)
        if (question?.layer !== 'theory_value' || !question.familyId) continue
        const list = perDimension.get(question.dimension) ?? []
        list.push(question.familyId)
        perDimension.set(question.dimension, list)
      }
      for (const [dimension, families] of perDimension) {
        expect(new Set(families).size, `${dimension} seed a-family-${index}`).toBe(families.length)
      }
    }
  })
})

describe('rule 2 — A0 is a self-description and never a number', () => {
  it('produces no numeric score for A0, in any draw', () => {
    for (let index = 0; index < 40; index += 1) {
      const { result } = run(`a0-${index}`)
      const a0 = result.dimensions.find((dimension) => dimension.id === A_LAYER_DIMENSIONS.a0)
      expect(a0, 'A0 must appear in the result').toBeDefined()
      expect(a0?.scoringKind).toBe('categorical')
      expect(a0?.scoredItems).toBe(0)
      expect(a0?.maxPossible).toBe(0)
      expect(a0?.normalizedScore).toBe(0)
      expect(a0?.band).toBe('不产生分数')
      expect(a0?.rawScore).toBe(0)
    }
  })

  it('reproduces the respondent’s own choice verbatim, with its declared category', () => {
    const { result, session } = run('a0-verbatim')
    const profile = result.aLayerProfile
    expect(profile).toBeDefined()
    expect(profile?.declaredIdentity.length).toBe(2)

    for (const item of profile?.declaredIdentity ?? []) {
      const question = byId.get(item.questionId)
      expect(question?.dimension).toBe(A_LAYER_DIMENSIONS.a0)
      const chosenOptionId = session.answers[item.questionId]
      const chosen = question?.options.find((option) => option.id === chosenOptionId)
      // The rendered text must be the option's own text, and the category its own declared category.
      expect(item.selectedText).toBe(chosen?.text)
      expect(item.selectedCategory).toBe(chosen?.selfReportCategory)
      expect(question?.scenarioType).toBe('self_report')
    }
  })

  it('carries no field that could hold an inferred identity', () => {
    const { result } = run('a0-no-inference')
    const serialised = JSON.stringify(result.aLayerProfile)
    for (const forbidden of [
      'politicalFitScore',
      'purityScore',
      'reliabilityScore',
      'admissionDecision',
      'rejectionDecision',
      'inferredIdentity',
    ]) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('keeps A0 out of the ranked strengths and development areas', () => {
    for (let index = 0; index < 20; index += 1) {
      const { result } = run(`a0-ranking-${index}`)
      for (const line of [...result.strengths, ...result.developmentAreas]) {
        expect(line).not.toContain(A_LAYER_DIMENSIONS.a0)
      }
    }
  })

  it('states the boundary inside the result, not only in the UI', () => {
    const { result } = run('a0-boundaries')
    const boundaries = result.aLayerProfile?.boundaries ?? []
    expect(boundaries.length).toBeGreaterThanOrEqual(4)
    expect(boundaries.join(' ')).toContain('自我认同（A0）只来自答题者本人的直接自报')
    expect(boundaries.join(' ')).toContain('不参与角色适配')
  })
})

describe('rule 3 — the A layer never reaches role-fit', () => {
  it('never lists an A dimension as a contributing dimension', () => {
    for (let index = 0; index < 30; index += 1) {
      const { result } = run(`a-rolefit-${index}`)
      for (const fit of result.roleFits) {
        for (const dimension of fit.contributingDimensions) {
          expect(A_DIMS).not.toContain(dimension)
        }
      }
    }
  })

  it('cannot be influenced by A-layer answers at all', () => {
    const created = createAssessment({
      bundle,
      seed: 'a-rolefit-isolation',
      sessionId: 'sess_iso',
      createdAt: FIXED_TIME,
    })
    const questions = paperQuestions(bundle, created.session)
    const base = simulateAnswers(questions, 'a-rolefit-isolation')
    const withExtremes: Record<string, string> = { ...base }
    // Force every A-layer answer to a different option than the simulation chose.
    for (const question of questions) {
      if (question.layer !== 'theory_value') continue
      const chosen = base[question.id]
      const alternative = question.options.find((option) => option.id !== chosen)
      if (alternative) withExtremes[question.id] = alternative.id
    }
    const a = completeAssessment(
      bundle,
      { ...created.session, answers: base },
      { generatedAt: FIXED_TIME },
    )
    const b = completeAssessment(
      bundle,
      { ...created.session, answers: withExtremes },
      { generatedAt: FIXED_TIME },
    )
    expect(JSON.stringify(a.result.roleFits)).toBe(JSON.stringify(b.result.roleFits))
  })
})

describe('rule 4 — the stale A-layer consistency mappings are gone', () => {
  it('keeps only the four B-B groups', () => {
    expect(scoring.confidence.consistencyGroups.map((group) => group.id)).toEqual([
      'CG01',
      'CG02',
      'CG03',
      'CG04',
    ])
  })

  it('references no theory-layer question from any group', () => {
    for (const group of scoring.confidence.consistencyGroups) {
      for (const questionId of group.questions) {
        expect(byId.get(questionId)?.layer, `${group.id} -> ${questionId}`).toBe(
          'cooperation_behavior',
        )
      }
    }
  })

  it('is enforced by the validator, so re-adding an A group fails the build', () => {
    // A real V1.1 A-layer id is used on purpose. Pointing at a *dangling* V1.0 id would be caught by
    // the reference check instead, so this simulates the subtler failure: someone "fixes" the stale
    // group by re-pointing its ids at the new items, which keeps the id valid while leaving the old
    // semantics attached to new questions. The semantic check is what catches that.
    const aLayerId = pack.questions.find((question) => question.layer === 'theory_value')?.id
    expect(aLayerId).toBeDefined()
    const tampered = {
      ...scoring,
      confidence: {
        ...scoring.confidence,
        consistencyGroups: [
          ...scoring.confidence.consistencyGroups,
          {
            id: 'CG05',
            questions: [aLayerId as string, 'B031'],
            type: 'directional_alignment' as const,
            note: 'stale mirror of the removed V1.0 group',
          },
        ],
      },
    }
    const report = validateQuestionPack({
      pack,
      scoring: tampered,
      roleModel,
      samplerStages: sampleQuestionSet({ pack, scoring, seed: 'stale-cg' }).stages,
    })
    const finding = report.findings.find(
      (entry) => entry.code === 'stale_a_consistency_groups_removed',
    )
    expect(finding?.severity).toBe('error')
    expect(finding?.subjects).toContain('CG05')
    expect(report.ok).toBe(false)
  })

  it('also catches the older failure mode where a group points at ids that no longer exist', () => {
    const tampered = {
      ...scoring,
      confidence: {
        ...scoring.confidence,
        consistencyGroups: [
          ...scoring.confidence.consistencyGroups,
          // A026 was a V1.0 A-layer item. V1.1 renumbers the A layer, so this is now dangling.
          {
            id: 'CG06',
            questions: ['A026', 'B031'],
            type: 'directional_alignment' as const,
            note: 'legacy id',
          },
        ],
      },
    }
    const report = validateQuestionPack({
      pack,
      scoring: tampered,
      roleModel,
      samplerStages: sampleQuestionSet({ pack, scoring, seed: 'legacy-cg' }).stages,
    })
    expect(
      report.findings.find((entry) => entry.code === 'consistency_group_reference')?.severity,
    ).toBe('error')
    expect(report.ok).toBe(false)
  })
})

describe('rule 5 — A1 answer positions are balanced across the bank', () => {
  it('puts the correct option at A, B, C and D three times each', () => {
    const a1 = pack.questions.filter(
      (question) =>
        question.layer === 'theory_value' && question.scoringMode === 'knowledge_accuracy',
    )
    expect(a1).toHaveLength(12)
    const positions = new Map<string, number>()
    for (const question of a1) {
      const values = question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)
      const best = Math.max(...values)
      const indexes = values
        .map((value, index) => (value === best ? index : -1))
        .filter((index) => index >= 0)
      expect(indexes, `${question.id} must have exactly one best option`).toHaveLength(1)
      const label = String.fromCharCode(65 + (indexes[0] ?? 0))
      positions.set(label, (positions.get(label) ?? 0) + 1)
    }
    expect(Object.fromEntries(positions)).toEqual({ A: 3, B: 3, C: 3, D: 3 })
  })

  it('still counts a correct answer as correct after position shuffling', () => {
    // Scoring is keyed by option id, so reordering must not change what is counted as right.
    const { result, session } = run('a1-shuffle-safety')
    const familiarity = result.aLayerProfile?.theoryFamiliarity
    expect(familiarity).toBeDefined()
    const a1Questions = paperQuestions(bundle, session).filter(
      (question) => question.dimension === A_LAYER_DIMENSIONS.a1,
    )
    let correct = 0
    for (const question of a1Questions) {
      const chosen = question.options.find((option) => option.id === session.answers[question.id])
      if (!chosen) continue
      const values = question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)
      const best = Math.max(...values)
      if ((Object.values(chosen.scoring ?? {})[0] ?? 0) === best) correct += 1
    }
    expect(familiarity?.correct).toBe(correct)
    expect(familiarity?.answered).toBe(a1Questions.length)
    expect(familiarity?.lowSample).toBe(true)
    expect(familiarity?.note).toContain('低精度')
  })
})

describe('rule 6 — A2/A3 semantic option order survives the shuffle stage', () => {
  const orderSensitive = pack.questions.filter(
    (question) => question.metadata?.optionOrderPolicy === 'preserve_or_reverse',
  )

  it('has order-sensitive items to protect in the first place', () => {
    expect(orderSensitive.length).toBeGreaterThan(0)
    for (const question of orderSensitive) {
      expect([A_LAYER_DIMENSIONS.a2, A_LAYER_DIMENSIONS.a3]).toContain(question.dimension)
    }
  })

  it('only ever emits the authored order or its exact reverse', () => {
    for (let index = 0; index < 60; index += 1) {
      const sampled = sampleQuestionSet({ pack, scoring, seed: `a-order-${index}` })
      const order = shuffleOptions(pack, sampled.questionIds, `a-order-${index}`)
      for (const entry of order) {
        const question = byId.get(entry.questionId)
        if (!question) continue
        const authored = question.options.map((option) => option.id)
        if (entry.policy !== 'preserve_or_reverse') continue
        const reversed = [...authored].reverse()
        expect(
          entry.optionIds.join(',') === authored.join(',') ||
            entry.optionIds.join(',') === reversed.join(','),
          `${entry.questionId} must keep its semantic order`,
        ).toBe(true)
      }
    }
  })

  it('uses both directions across the bank rather than always reversing or never reversing', () => {
    const directions = new Set<string>()
    for (let index = 0; index < 60; index += 1) {
      const sampled = sampleQuestionSet({ pack, scoring, seed: `a-dir-${index}` })
      const order = shuffleOptions(pack, sampled.questionIds, `a-dir-${index}`)
      for (const entry of order) {
        if (entry.policy !== 'preserve_or_reverse') continue
        const question = byId.get(entry.questionId)
        if (!question) continue
        const authored = question.options.map((option) => option.id).join(',')
        directions.add(entry.optionIds.join(',') === authored ? 'forward' : 'reverse')
      }
    }
    // Position bias is halved by mixing the two; seeing only one direction would mean the mixing
    // silently stopped working.
    expect(directions.has('forward')).toBe(true)
    expect(directions.has('reverse')).toBe(true)
  })

  it('leaves A0 fixed and free-shuffles the knowledge items', () => {
    const a0 = pack.questions.filter((question) => question.dimension === A_LAYER_DIMENSIONS.a0)
    for (const question of a0) {
      const resolved = resolveOptionOrder(question, 'a0-fixed-check')
      expect(resolved.policy).toBe('fixed')
      expect(resolved.optionIds).toEqual(question.options.map((option) => option.id))
    }
    const knowledge = pack.questions.filter(
      (question) => question.scoringMode === 'knowledge_accuracy',
    )
    for (const question of knowledge) {
      expect(resolveOptionOrder(question, 'a1-shuffle-check').policy).toBe('shuffle')
    }
  })

  it('is reproducible: the same seed re-derives the same order', () => {
    const sampled = sampleQuestionSet({ pack, scoring, seed: 'a-order-repro' })
    const first = shuffleOptions(pack, sampled.questionIds, 'a-order-repro')
    const second = shuffleOptions(pack, sampled.questionIds, 'a-order-repro')
    expect(second).toEqual(first)
  })
})

describe('rule 7 — a V1.0 session cannot be scored against the V1.1 pack', () => {
  it('refuses the mismatch by version instead of reinterpreting the answers', () => {
    const { session } = run('a-version-guard')
    // A V1.0 session stored `scoringVersion: 1.0.0` and `questionPackVersion: 1.0.0`.
    expect(() =>
      scoreAssessment({
        pack,
        scoring,
        roleModel,
        session: {
          ...session,
          scoringVersion: '1.0.0',
          questionPackVersion: '1.0.0',
        },
        generatedAt: FIXED_TIME,
      }),
    ).toThrow(/不允许/)
  })

  it('names the versions in the refusal so the cause is diagnosable', () => {
    const { session } = run('a-version-message')
    try {
      scoreAssessment({
        pack,
        scoring,
        roleModel,
        session: { ...session, scoringVersion: '1.0.0' },
        generatedAt: FIXED_TIME,
      })
      throw new Error('expected a refusal')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('1.0.0')
      expect(message).toContain(scoring.version)
    }
  })

  it('boots on the V1.1 bundle and reports both versions in the result', () => {
    const { result } = run('a-version-stamp')
    expect(result.versions.scoring).toBe('scoring-v1.1@1.1.0')
    expect(result.versions.questionPack).toBe('cohortlens-question-pack-v1.1@1.1.0')
  })
})

describe('the AI payload carries the A-layer boundaries, not the answer sheet', () => {
  it('sends A0 categories but never the chosen option text', () => {
    const { result, session } = run('payload-a0')
    const payload = buildReportPayload({ result, pack })
    expect(payload.aLayer).toBeDefined()
    expect(payload.aLayer?.declaredIdentity).toHaveLength(
      result.aLayerProfile?.declaredIdentity.length ?? -1,
    )

    // Every chosen option's text, for every answered question, must be absent from the payload.
    const questions = paperQuestions(bundle, session)
    const serialised = JSON.stringify(payload)
    let checked = 0
    for (const question of questions) {
      const optionId = session.answers[question.id]
      const option = question.options.find((candidate) => candidate.id === optionId)
      if (!option) continue
      checked += 1
      // Option text is long enough that an accidental inclusion would be a real leak, not a
      // coincidental substring match.
      if (option.text.length >= 12) {
        expect(serialised, `answer text leaked: ${question.id}`).not.toContain(option.text)
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('sends A2-A4 as counts and topic labels, with no selectedText field', () => {
    const { result } = run('payload-cards')
    const payload = buildReportPayload({ result, pack })
    const measured = payload.aLayer?.measuredItems ?? []
    expect(measured.length).toBeGreaterThan(0)
    for (const entry of measured) {
      expect(entry.itemCount).toBeGreaterThan(0)
      expect(entry.topics.length).toBe(entry.itemCount)
      expect(entry).not.toHaveProperty('selectedText')
      expect(entry).not.toHaveProperty('cards')
    }
    const serialised = JSON.stringify(measured)
    for (const card of result.aLayerProfile?.politicalEconomy ?? []) {
      expect(serialised).not.toContain(card.selectedText)
    }
  })

  it('tells the model which A dimensions have no score, so 0 is not read as "scored badly"', () => {
    const { result } = run('payload-scoring-kind')
    const payload = buildReportPayload({ result, pack })
    const byDimension = new Map(payload.dimensions.map((dimension) => [dimension.id, dimension]))
    expect(byDimension.get(A_LAYER_DIMENSIONS.a0)?.scoringKind).toBe('categorical')
    expect(byDimension.get(A_LAYER_DIMENSIONS.a0)?.scoredItems).toBe(0)
    expect(byDimension.get(A_LAYER_DIMENSIONS.a1)?.scoringKind).toBe('knowledge')
    for (const dimensionId of [
      A_LAYER_DIMENSIONS.a2,
      A_LAYER_DIMENSIONS.a3,
      A_LAYER_DIMENSIONS.a4,
      A_LAYER_DIMENSIONS.a5,
    ]) {
      expect(byDimension.get(dimensionId)?.scoringKind, dimensionId).toBe('descriptive')
    }
  })

  it('states the no-total and no-inference boundaries inside the payload itself', () => {
    const { result } = run('payload-boundaries')
    const payload = buildReportPayload({ result, pack })
    const combined = [...payload.boundaries, ...(payload.aLayer?.boundaries ?? [])].join(' ')
    expect(combined).toContain('不得从 A1 到 A5')
    expect(combined).toContain('不得相加')
    expect(combined).toContain('不参与角色适配')
  })

  it('leaves aLayer absent for a result that has no A-layer profile', () => {
    const { result } = run('payload-legacy-shape')
    const withoutProfile = { ...result }
    delete (withoutProfile as { aLayerProfile?: unknown }).aLayerProfile
    const payload = buildReportPayload({ result: withoutProfile, pack })
    expect(payload.aLayer).toBeUndefined()
  })
})

describe('the report prompt tells the model how to treat each A part', () => {
  it('mandates an A-layer section and names the six-part rule', () => {
    expect(MANDATED_SECTIONS_ZH).toContain('## A 层画像的呈现方式')
    expect(REPORT_PROMPT_VERSION).toMatch(/^report-prompt-v\d+$/)
  })

  it('carries every A-layer constraint into the system prompt', () => {
    const { result } = run('prompt-constraints')
    const prompt = buildReportPrompt(buildReportPayload({ result, pack }), 'zh')
    for (const required of [
      '不得从 A1 到 A5',
      'lowSample',
      '不得描述、猜测或复述',
      '材料不足',
      '不得相加',
      '不得用于角色适配',
    ]) {
      expect(prompt.system, required).toContain(required)
    }
    // The prompt must not still claim the whole theory layer is non-political: A2/A3 now genuinely
    // carry self-reported positions, and denying that would be inaccurate.
    expect(prompt.system).not.toContain('不把理论层（theory_value）结果解释为政治立场')
  })

  it('embeds the payload so the model has nothing to invent', () => {
    const { result } = run('prompt-payload')
    const payload = buildReportPayload({ result, pack })
    const prompt = buildReportPrompt(payload, 'zh')
    expect(prompt.user).toContain('"aLayer"')
    expect(prompt.user).toContain('declaredIdentity')
    expect(prompt.version).toBe(REPORT_PROMPT_VERSION)
  })
})

describe('A2-A5 are evidence cards, not axis scores', () => {
  it('renders the raw issue positions instead of a normalised axis score', () => {
    const { result, session } = run('a-cards')
    const profile = result.aLayerProfile
    expect(profile).toBeDefined()
    for (const [cardsKey, dimension] of [
      ['politicalEconomy', A_LAYER_DIMENSIONS.a2],
      ['socialPolitical', A_LAYER_DIMENSIONS.a3],
      ['practiceOrientation', A_LAYER_DIMENSIONS.a4],
    ] as const) {
      const cards = profile?.[cardsKey] ?? []
      const inPaper = paperQuestions(bundle, session).filter(
        (question) => question.dimension === dimension,
      )
      expect(cards, cardsKey).toHaveLength(inPaper.length)
      for (const card of cards) {
        const question = byId.get(card.questionId)
        const chosen = question?.options.find(
          (option) => option.id === session.answers[card.questionId],
        )
        expect(card.selectedText).toBe(chosen?.text)
        expect(card.topic).toBe(question?.subDimension)
        expect(card).not.toHaveProperty('score')
      }
    }
  })

  it('does not surface the exploratory axis signals to the user', () => {
    const { result } = run('a-exploratory-hidden')
    const serialised = JSON.stringify(result.aLayerProfile)
    // Axis ids are calibration vocabulary; they must not reach the rendered result.
    for (const axis of ['egalitarian_distribution', 'internal_pluralism', 'decommodification']) {
      expect(serialised).not.toContain(axis)
    }
  })

  it('reports A2-A5 as descriptive with no number and an explanatory warning', () => {
    const { result } = run('a-descriptive')
    for (const dimensionId of [
      A_LAYER_DIMENSIONS.a2,
      A_LAYER_DIMENSIONS.a3,
      A_LAYER_DIMENSIONS.a4,
      A_LAYER_DIMENSIONS.a5,
    ]) {
      const dimension = result.dimensions.find((entry) => entry.id === dimensionId)
      expect(dimension?.scoringKind, dimensionId).toBe('descriptive')
      expect(dimension?.scoredItems, dimensionId).toBe(0)
      expect(dimension?.band, dimensionId).toBe('不产生分数')
      expect(
        dimension?.warnings?.some((warning) => warning.includes('描述性证据')),
        dimensionId,
      ).toBe(true)
    }
  })

  it('only lets A5 speak when its items agree, and says "mixed" or "insufficient" otherwise', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      const { result } = run(`a5-${index}`)
      const reflexivity = result.aLayerProfile?.reflexivity
      expect(reflexivity, `a5-${index}`).toBeDefined()
      seen.add(reflexivity?.state ?? 'missing')
      if (reflexivity?.state !== 'aligned') {
        expect(reflexivity?.confidence).toBeLessThan(0.4)
      } else {
        expect(reflexivity?.summary).toContain('低置信度')
      }
      for (const questionId of reflexivity?.evidenceQuestionIds ?? []) {
        expect(byId.get(questionId)?.dimension).toBe(A_LAYER_DIMENSIONS.a5)
      }
    }
    // Over 40 draws all three states should occur; a permanent single state would mean the
    // alignment test is not really running.
    expect(seen.size).toBeGreaterThan(1)
  })

  it('never produces an A-layer total, in any field', () => {
    for (let index = 0; index < 10; index += 1) {
      const { result } = run(`a-total-${index}`)
      const serialised = JSON.stringify(result)
      for (const forbidden of ['"aTotal"', '"aLayerTotal"', '"politicalFit"', '"ideologyScore"']) {
        expect(serialised).not.toContain(forbidden)
      }
    }
  })
})

describe('the A-layer profile is printable without becoming a scoreboard', () => {
  it('renders each of the six parts and never a 0/100 row for A0', () => {
    const { result } = run('print-a-layer')
    const text = renderResultText(result, pack)
    for (const section of [
      '1 · 自我声明的理论认同（A0，直接自报，无分数）',
      '2 · 理论熟悉程度（A1，低精度提示 low sample）',
      '3 · 政治经济议题立场（A2，原始立场，不折算分数）',
      '4 · 社会—政治议题立场（A3，原始立场，不折算分数）',
      '5 · 实践取向（A4，原始取向，不折算分数）',
      '6 · 反身性与修正方式（A5）',
      '不参与角色适配，不生成任何综合分',
    ]) {
      expect(text, section).toContain(section)
    }
    // A0 must never be rendered as a bar or a 0/100 row.
    expect(text).not.toContain('自我声明的理论认同（A0_declared_identity）')
    expect(text).toContain('A0，直接自报，无分数')
  })

  it('keeps printing B and C as ordinary score rows', () => {
    const { result } = run('print-bc')
    const text = renderResultText(result, pack)
    expect(text).toContain('B 层 / 合作与行为（自陈材料）')
    expect(text).toContain('C 层 / 技能与角色（自陈材料）')
    expect(text).toContain('/ 100')
  })
})
