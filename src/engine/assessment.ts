import {
  assessmentSessionSchema,
  type AssessmentResult,
  type AssessmentSession,
  type Question,
} from '../domain/schemas.ts'
import { createId, createSeed, nowIso } from '../utils/ids.ts'
import { createRng } from './rng.ts'
import { sampleQuestionSet, shuffleOptions, type ShuffledOptionOrder } from './sampler.ts'
import { scoreAssessment } from './scoring.ts'
import type { ContentBundle } from '../content/load-content.ts'

/**
 * Assessment use case — the thin layer between the UI and the deterministic core.
 *
 * Engineering Bible §12/§13: creating an assessment mints a sessionId and a seed, records the
 * pack/scoring/role-model versions, and freezes the drawn `questionIds`. Everything after that is
 * a pure function of the stored session, which is why a refresh can never change a paper.
 */

export interface CreateAssessmentOptions {
  bundle: ContentBundle
  /** Fixed seed for reproducible tests and demos. A fresh random seed is used when omitted. */
  seed?: string
  sessionId?: string
  createdAt?: string
  previousSessions?: readonly { seed: string; shortDimension: string | null }[]
}

export interface CreatedAssessment {
  session: AssessmentSession
  /** Option render order per question. Stored so a restored session renders identically. */
  optionOrder: ShuffledOptionOrder[]
  shortDimension: string | null
  stages: ReturnType<typeof sampleQuestionSet>['stages']
}

export function createAssessment({
  bundle,
  seed,
  sessionId,
  createdAt,
  previousSessions = [],
}: CreateAssessmentOptions): CreatedAssessment {
  const { pack, scoring, roleModel } = bundle
  const resolvedSeed = seed ?? createSeed()
  const sampled = sampleQuestionSet({ pack, scoring, seed: resolvedSeed, previousSessions })
  const timestamp = createdAt ?? nowIso()

  const session = assessmentSessionSchema.parse({
    id: sessionId ?? createId('session'),
    createdAt: timestamp,
    updatedAt: timestamp,
    questionPackId: pack.id,
    questionPackVersion: pack.version,
    scoringVersion: scoring.version,
    roleModelVersion: roleModel.version,
    seed: resolvedSeed,
    questionIds: sampled.questionIds,
    answers: {},
    shortDimension: sampled.layerAShortDimension,
    status: 'draft',
  })

  return {
    session,
    optionOrder: shuffleOptions(pack, sampled.questionIds, resolvedSeed),
    shortDimension: sampled.layerAShortDimension,
    stages: sampled.stages,
  }
}

export function answerQuestion(
  session: AssessmentSession,
  questionId: string,
  optionId: string,
  answeredAt: string = nowIso(),
): AssessmentSession {
  if (!session.questionIds.includes(questionId)) {
    throw new Error(`题目 ${questionId} 不在本次问卷中，无法作答`)
  }
  return assessmentSessionSchema.parse({
    ...session,
    answers: { ...session.answers, [questionId]: optionId },
    updatedAt: answeredAt,
  })
}

export interface CompletionReport {
  session: AssessmentSession
  result: AssessmentResult
}

export function completeAssessment(
  bundle: ContentBundle,
  session: AssessmentSession,
  options: {
    generatedAt?: string
    previousSessions?: readonly { seed: string; shortDimension: string | null }[]
  },
): CompletionReport {
  const { pack, scoring, roleModel } = bundle
  const generatedAt = options.generatedAt ?? nowIso()
  const completed = assessmentSessionSchema.parse({
    ...session,
    updatedAt: generatedAt,
    completedAt: generatedAt,
    status: 'completed',
  })
  // Re-derive the sampler stages from the stored session so the report can state which §10
  // stages were live for this paper, without persisting a second copy of the pack state.
  const stages = sampleQuestionSet({
    pack,
    scoring,
    seed: session.seed,
    previousSessions: options.previousSessions ?? [],
  }).stages

  const result = scoreAssessment({
    pack,
    scoring,
    roleModel,
    session: completed,
    generatedAt,
    samplerStages: stages,
  })
  return { session: completed, result }
}

/**
 * Deterministic answer simulation for demos and tests.
 *
 * ADR-009: the demo answers are produced by the engine's own seeded PRNG from
 * `"<seed>::simulate::<questionId>"`, so a demo run is reproducible byte-for-byte. This is a
 * clearly-labelled simulation, never presented as a real respondent's data, and it deliberately
 * does NOT always pick the highest-scoring option — a demo that only ever answers "perfectly"
 * would hide exactly the coarse-granularity behaviour the report needs to show.
 */
export function simulateAnswers(
  questions: readonly Question[],
  seed: string,
  style: 'balanced' | 'high' | 'low' = 'balanced',
): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const rng = createRng(`${seed}::simulate::${question.id}`)
    const values = question.options.map((option) => Object.values(option.scoring ?? {})[0] ?? 0)
    const max = Math.max(...values)
    const min = Math.min(...values)
    let index: number
    if (style === 'high') {
      index = values.indexOf(max)
    } else if (style === 'low') {
      index = values.indexOf(min)
    } else {
      const roll = rng.next()
      if (roll < 0.5) index = values.indexOf(max)
      else if (roll < 0.8) index = values.indexOf(min)
      else index = rng.nextInt(question.options.length)
    }
    const option = question.options[index] ?? question.options[0]
    if (option) answers[question.id] = option.id
  }
  return answers
}

export function paperQuestions(bundle: ContentBundle, session: AssessmentSession): Question[] {
  const byId = new Map(bundle.pack.questions.map((question) => [question.id, question]))
  return session.questionIds
    .map((questionId) => byId.get(questionId))
    .filter((question): question is Question => question !== undefined)
}
