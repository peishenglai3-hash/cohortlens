import { create } from 'zustand'
import type { AssessmentResult, AssessmentSession, Question } from '../domain/schemas.ts'
import { loadContentBundle } from '../content/load-content.ts'
import { completeAssessment, createAssessment, paperQuestions } from '../engine/assessment.ts'
import type { ShuffledOptionOrder } from '../engine/sampler.ts'

/**
 * In-memory assessment store for the V0.1 slice.
 *
 * Scope note (recorded in the delivery report): persistence is deliberately NOT wired to
 * IndexedDB yet, so a page refresh restarts the session. The engine is already refresh-safe —
 * `createAssessment` freezes `questionIds` and the option order into the session object, and
 * `assessment-flow.test.ts` proves a restored session reproduces the same paper and result — so
 * persistence is a storage-layer addition, not an engine change. Engineering Bible §54 stays on
 * the 待验证 list until that layer lands.
 */

export interface AssessmentState {
  session: AssessmentSession | null
  optionOrder: ShuffledOptionOrder[]
  questions: Question[]
  result: AssessmentResult | null
  index: number
  error: string | null

  start: (seed?: string) => void
  answer: (questionId: string, optionId: string) => void
  goTo: (index: number) => void
  next: () => void
  previous: () => void
  finish: () => void
  reset: () => void
}

export const useAssessmentStore = create<AssessmentState>((set, get) => ({
  session: null,
  optionOrder: [],
  questions: [],
  result: null,
  index: 0,
  error: null,

  start: (seed) => {
    try {
      const bundle = loadContentBundle()
      const created = createAssessment(seed === undefined ? { bundle } : { bundle, seed })
      set({
        session: created.session,
        optionOrder: created.optionOrder,
        questions: paperQuestions(bundle, created.session),
        result: null,
        index: 0,
        error: null,
      })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  answer: (questionId, optionId) => {
    const { session } = get()
    if (!session) return
    set({
      session: { ...session, answers: { ...session.answers, [questionId]: optionId } },
    })
  },

  goTo: (index) => {
    const { questions } = get()
    if (index < 0 || index >= questions.length) return
    set({ index })
  },

  next: () => get().goTo(get().index + 1),
  previous: () => get().goTo(get().index - 1),

  finish: () => {
    const { session } = get()
    if (!session) return
    try {
      const bundle = loadContentBundle()
      const { session: completed, result } = completeAssessment(bundle, session, {})
      set({ session: completed, result })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  reset: () =>
    set({ session: null, optionOrder: [], questions: [], result: null, index: 0, error: null }),
}))

/** Options for one question in the frozen render order (Engineering Bible §10, §12). */
export function optionsForQuestion(
  question: Question,
  optionOrder: readonly ShuffledOptionOrder[],
): Question['options'] {
  const order = optionOrder.find((entry) => entry.questionId === question.id)?.optionIds
  if (!order) return question.options
  const byId = new Map(question.options.map((option) => [option.id, option]))
  const ordered = order
    .map((optionId) => byId.get(optionId))
    .filter((option): option is Question['options'][number] => option !== undefined)
  return ordered.length === question.options.length ? ordered : question.options
}
