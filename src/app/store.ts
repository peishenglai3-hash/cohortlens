import { create } from 'zustand'
import type { AssessmentResult, AssessmentSession, Question } from '../domain/schemas.ts'
import { loadContentBundle } from '../content/load-content.ts'
import {
  answerQuestion,
  completeAssessment,
  createAssessment,
  paperQuestions,
} from '../engine/assessment.ts'
import { shuffleOptions } from '../engine/sampler.ts'
import {
  getRepositories,
  PersistenceUnavailableError,
  type Repositories,
} from '../infrastructure/storage/index.ts'
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from '../infrastructure/storage/settings-repository.ts'
import type { ReportRecord } from '../infrastructure/storage/report-repository.ts'

/**
 * The application store.
 *
 * Layering rule for the whole Local MVP: components talk to this store, the store talks to
 * repositories, repositories talk to IndexedDB. No component opens a database transaction.
 *
 * Persistence behaviour required by the Local MVP brief:
 *   - every answer is written immediately — not on "next", not on unload;
 *   - reloading or reopening the browser restores the paper from the stored `questionIds`, so a
 *     refresh can never re-draw the questions (Engineering Bible §12);
 *   - the option render order is derived from the stored seed, so a restored paper looks identical.
 */

export type BootStatus = 'idle' | 'loading' | 'ready' | 'persistence-unavailable' | 'error'

export interface HistoryEntry {
  session: AssessmentSession
  result: AssessmentResult | null
  hasReport: boolean
  answered: number
  total: number
}

export interface AppState {
  bootStatus: BootStatus
  bootError: string | null

  settings: AppSettings
  secretsSaved: boolean

  session: AssessmentSession | null
  questions: Question[]
  result: AssessmentResult | null
  report: ReportRecord | null
  index: number

  history: HistoryEntry[]

  /**
   * Persistence bookkeeping, surfaced so a user (and an automated test) can tell whether what is
   * on screen has actually reached IndexedDB. Without it, "I answered, then reloaded" can race the
   * asynchronous write and look like data loss when nothing was lost.
   */
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  savedAt: string | null

  /** Report generation progress, independent of the base result (§62). */
  reportStatus: 'idle' | 'generating' | 'ready' | 'failed'
  reportError: string | null

  boot: () => Promise<void>
  startNew: (options?: { seed?: string }) => Promise<void>
  resume: (sessionId: string) => Promise<void>
  answer: (questionId: string, optionId: string) => Promise<void>
  goTo: (index: number) => void
  next: () => void
  previous: () => void
  finish: () => Promise<void>
  refreshHistory: () => Promise<void>
  openResult: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  setReport: (report: ReportRecord | null) => void
  setReportStatus: (status: AppState['reportStatus'], error?: string | null) => void
  clearAllData: () => Promise<void>
}

let repositoriesPromise: Promise<Repositories> | null = null

async function repositories(): Promise<Repositories> {
  repositoriesPromise ??= getRepositories()
  return repositoriesPromise
}

/**
 * Session write queue.
 *
 * A session is saved on every answer and every page turn. Firing those writes concurrently is
 * wrong: IndexedDB offers no ordering guarantee across separate transactions, so an earlier,
 * smaller state can land *after* a later one and silently roll the stored session backwards —
 * which is exactly how "I answered eight questions and it came back with two" happens.
 *
 * The queue keeps only the newest pending state (a latest-wins slot) and writes one at a time.
 * Intermediate states are dropped, which is correct because a session is one self-contained
 * record. `flushSessionWrites` resolves once the queue has drained, so a caller — or an automated
 * test — can wait for durability instead of racing it.
 */
let pendingSession: AssessmentSession | null = null
let sessionWriter: Promise<void> | null = null
let lastWriteError: string | null = null

function enqueueSessionWrite(session: AssessmentSession): Promise<void> {
  pendingSession = session
  sessionWriter ??= (async () => {
    try {
      while (pendingSession) {
        const next = pendingSession
        pendingSession = null
        try {
          const repos = await repositories()
          await repos.sessions.put(next)
          lastWriteError = null
        } catch (error) {
          lastWriteError = error instanceof Error ? error.message : String(error)
        }
      }
    } finally {
      sessionWriter = null
    }
  })()
  return sessionWriter
}

/** Resolves once no session write is outstanding. Throws if a write failed. */
export async function flushSessionWrites(): Promise<void> {
  while (sessionWriter) await sessionWriter
  if (lastWriteError) throw new Error(lastWriteError)
}

/** Test/lifecycle hook: forget the memoised repository container and any queued write. */
export function resetStoreRepositories(): void {
  repositoriesPromise = null
  pendingSession = null
  sessionWriter = null
  lastWriteError = null
}

function questionsFor(session: AssessmentSession): Question[] {
  return paperQuestions(loadContentBundle(), session)
}

/**
 * Where to drop a returning user.
 *
 * `lastIndex` is authoritative when present: it is where they actually were. Older sessions (or a
 * session saved before this field existed) fall back to the first unanswered question, then to 0.
 */
function resumeIndexFor(session: AssessmentSession): number {
  const total = session.questionIds.length
  if (typeof session.lastIndex === 'number') {
    return Math.max(0, Math.min(session.lastIndex, Math.max(0, total - 1)))
  }
  const firstUnanswered = session.questionIds.findIndex(
    (questionId) => session.answers[questionId] === undefined,
  )
  return firstUnanswered < 0 ? 0 : firstUnanswered
}

export const useAppStore = create<AppState>((set, get) => ({
  bootStatus: 'idle',
  bootError: null,

  settings: { ...DEFAULT_APP_SETTINGS },
  secretsSaved: false,

  session: null,
  questions: [],
  result: null,
  report: null,
  index: 0,

  history: [],

  saveState: 'idle',
  savedAt: null,

  reportStatus: 'idle',
  reportError: null,

  boot: async () => {
    set({ bootStatus: 'loading', bootError: null })
    try {
      const repos = await repositories()
      const settings = await repos.settings.load()
      const secretsSaved = await repos.settings.hasSecret()

      let session: AssessmentSession | null = null
      let result: AssessmentResult | null = null
      let report: ReportRecord | null = null

      if (settings.currentSessionId) {
        session = await repos.sessions.get(settings.currentSessionId)
        if (session) {
          result = session.resultId
            ? await repos.results.get(session.resultId)
            : await repos.results.findBySession(session.id)
          if (result) report = await repos.reports.getByResult(result.id)
        }
      }

      set({
        bootStatus: 'ready',
        settings,
        secretsSaved,
        session,
        questions: session ? questionsFor(session) : [],
        result,
        report,
        index: session ? resumeIndexFor(session) : 0,
        reportStatus: report ? 'ready' : 'idle',
        reportError: null,
      })
      await get().refreshHistory()
    } catch (error) {
      if (error instanceof PersistenceUnavailableError) {
        // A browser with storage disabled must not white-screen: local scoring still works, only
        // resume-across-reload is lost. The UI says so plainly instead of failing.
        set({ bootStatus: 'persistence-unavailable', bootError: error.message })
        return
      }
      set({
        bootStatus: 'error',
        bootError: error instanceof Error ? error.message : String(error),
      })
    }
  },

  startNew: async (options) => {
    const bundle = loadContentBundle()
    const created = createAssessment(
      options?.seed === undefined ? { bundle } : { bundle, seed: options.seed },
    )
    set({
      session: created.session,
      questions: paperQuestions(bundle, created.session),
      result: null,
      report: null,
      index: 0,
      reportStatus: 'idle',
      reportError: null,
      saveState: 'saving',
    })
    try {
      const repos = await repositories()
      await enqueueSessionWrite(created.session)
      const settings = await repos.settings.patch({ currentSessionId: created.session.id })
      set({ settings, saveState: 'saved', savedAt: new Date().toISOString() })
      await get().refreshHistory()
    } catch (error) {
      set({
        bootError: error instanceof Error ? error.message : String(error),
        saveState: 'error',
      })
    }
  },

  resume: async (sessionId) => {
    try {
      const repos = await repositories()
      const session = await repos.sessions.get(sessionId)
      if (!session) {
        set({ bootError: `找不到会话 ${sessionId}` })
        return
      }
      const stored = session.resultId
        ? await repos.results.get(session.resultId)
        : await repos.results.findBySession(session.id)
      const report = stored ? await repos.reports.getByResult(stored.id) : null
      set({
        session,
        questions: questionsFor(session),
        result: stored ?? null,
        report,
        index: resumeIndexFor(session),
        reportStatus: report ? 'ready' : 'idle',
        reportError: null,
      })
      const settings = await repos.settings.patch({ currentSessionId: session.id })
      set({ settings })
    } catch (error) {
      set({ bootError: error instanceof Error ? error.message : String(error) })
    }
  },

  answer: async (questionId, optionId) => {
    const { session, index } = get()
    if (!session) return
    // Fold the reading position into the same record that carries the answer, so a single write
    // always leaves the stored session internally consistent.
    const updated = { ...answerQuestion(session, questionId, optionId), lastIndex: index }
    // Update the UI first, then persist, so answering never waits on disk.
    set({ session: updated, saveState: 'saving' })
    try {
      await enqueueSessionWrite(updated)
      set({ saveState: 'saved', savedAt: new Date().toISOString() })
    } catch (error) {
      set({
        bootError: `保存作答失败：${error instanceof Error ? error.message : String(error)}`,
        saveState: 'error',
      })
    }
  },

  goTo: (index) => {
    const { questions, session } = get()
    const total = questions.length
    if (index < 0 || index >= total) return
    set({ index })
    // Persist the reading position so a refresh returns to this question, not to the first one.
    // Same queue as answers: one ordered writer, newest state wins.
    if (session) {
      const updated = { ...session, lastIndex: index }
      set({ session: updated })
      void enqueueSessionWrite(updated).catch((error: unknown) =>
        set({
          bootError: `保存进度位置失败：${error instanceof Error ? error.message : String(error)}`,
        }),
      )
    }
  },

  next: () => get().goTo(get().index + 1),
  previous: () => get().goTo(get().index - 1),

  finish: async () => {
    const { session } = get()
    if (!session) return
    try {
      const bundle = loadContentBundle()
      const { session: completed, result } = completeAssessment(bundle, session, {})
      const linked: AssessmentSession = { ...completed, resultId: result.id }
      set({
        session: linked,
        result,
        report: null,
        reportStatus: 'idle',
        reportError: null,
        saveState: 'saving',
      })
      const repos = await repositories()
      await enqueueSessionWrite(linked)
      await repos.results.put(result)
      set({ saveState: 'saved', savedAt: new Date().toISOString() })
      await get().refreshHistory()
    } catch (error) {
      set({
        bootError: error instanceof Error ? error.message : String(error),
        saveState: 'error',
      })
    }
  },

  refreshHistory: async () => {
    try {
      const repos = await repositories()
      const sessions = await repos.sessions.listAll()
      const results = await repos.results.listAll()
      const reportIds = await repos.reports.listResultIds()
      const bySession = new Map(results.map((result) => [result.sessionId, result]))
      const entries: HistoryEntry[] = sessions.map((session) => {
        const result = session.resultId
          ? (results.find((candidate) => candidate.id === session.resultId) ?? null)
          : (bySession.get(session.id) ?? null)
        return {
          session,
          result,
          hasReport: result ? reportIds.has(result.id) : false,
          answered: Object.keys(session.answers).length,
          total: session.questionIds.length,
        }
      })
      set({ history: entries })
    } catch (error) {
      set({ bootError: error instanceof Error ? error.message : String(error) })
    }
  },

  openResult: async (sessionId) => {
    await get().resume(sessionId)
  },

  deleteSession: async (sessionId) => {
    try {
      const repos = await repositories()
      const results = await repos.results.listBySession(sessionId)
      for (const result of results) {
        await repos.reports.delete(result.id)
        await repos.results.delete(result.id)
      }
      await repos.sessions.delete(sessionId)
      if (get().settings.currentSessionId === sessionId) {
        const settings = await repos.settings.patch({ currentSessionId: null })
        set({ settings })
      }
      if (get().session?.id === sessionId) {
        set({
          session: null,
          questions: [],
          result: null,
          report: null,
          index: 0,
          reportStatus: 'idle',
        })
      }
      await get().refreshHistory()
    } catch (error) {
      set({ bootError: error instanceof Error ? error.message : String(error) })
    }
  },

  saveSettings: async (patch) => {
    try {
      const repos = await repositories()
      const next = await repos.settings.patch(patch)
      set({ settings: next })
    } catch (error) {
      set({ bootError: error instanceof Error ? error.message : String(error) })
    }
  },

  setReport: (report) =>
    set({ report, reportStatus: report ? 'ready' : 'idle', reportError: null }),

  setReportStatus: (status, error = null) => set({ reportStatus: status, reportError: error }),

  clearAllData: async () => {
    try {
      const repos = await repositories()
      await repos.handle.clearAll()
      set({
        session: null,
        questions: [],
        result: null,
        report: null,
        history: [],
        index: 0,
        settings: { ...DEFAULT_APP_SETTINGS },
        secretsSaved: false,
        saveState: 'idle',
        savedAt: null,
        reportStatus: 'idle',
        reportError: null,
        bootError: null,
      })
    } catch (error) {
      set({ bootError: error instanceof Error ? error.message : String(error) })
    }
  },
}))

/**
 * Options for one question in the frozen render order.
 *
 * The order is re-derived from the stored seed rather than persisted separately, which keeps the
 * session record small and makes it impossible for the stored order to disagree with the answers
 * (both are keyed by option id, never by position).
 */
export function optionsForQuestion(
  question: Question,
  session: AssessmentSession | null,
): Question['options'] {
  if (!session) return question.options
  const { pack } = loadContentBundle()
  const entry = shuffleOptions(pack, session.questionIds, session.seed).find(
    (order) => order.questionId === question.id,
  )
  if (!entry) return question.options
  const byId = new Map(question.options.map((option) => [option.id, option]))
  const ordered = entry.optionIds
    .map((optionId) => byId.get(optionId))
    .filter((option): option is Question['options'][number] => option !== undefined)
  return ordered.length === question.options.length ? ordered : question.options
}
