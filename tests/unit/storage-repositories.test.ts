import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabaseHandle, type DatabaseHandle } from '../../src/infrastructure/storage/db.ts'
import { createRepositories, type Repositories } from '../../src/infrastructure/storage/index.ts'
import { DEFAULT_APP_SETTINGS } from '../../src/infrastructure/storage/settings-repository.ts'
import { loadContentBundle } from '../../src/content/load-content.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'

/**
 * Repository tests against a real (in-memory) IndexedDB implementation.
 *
 * `fake-indexeddb` gives the tests the same API the browser gives the app, so these tests exercise
 * actual transactions, indexes and the upgrade path rather than a hand-written stub. Each test
 * uses a fresh database name so runs cannot contaminate each other.
 */

const bundle = loadContentBundle()
let counter = 0
let handle: DatabaseHandle
let repos: Repositories

beforeEach(async () => {
  counter += 1
  handle = await createDatabaseHandle(`cohortlens-test-${counter}`)
  repos = createRepositories(handle)
})

afterEach(() => {
  handle.close()
})

function buildSession(seed: string, answeredAll = true) {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `sess_${seed}`,
    createdAt: '2026-10-07T12:00:00.000Z',
  })
  const questions = paperQuestions(bundle, created.session)
  const answers = answeredAll ? simulateAnswers(questions, seed) : {}
  return { ...created.session, answers }
}

describe('session repository', () => {
  it('round-trips a session and validates it against the schema', async () => {
    const session = buildSession('repo-1')
    await repos.sessions.put(session)
    const loaded = await repos.sessions.get(session.id)
    expect(loaded?.id).toBe(session.id)
    expect(loaded?.questionIds).toEqual(session.questionIds)
    expect(loaded?.updatedAt).toBe(session.updatedAt)
  })

  it('enforces the paper: the stored questionIds are what come back, in order', async () => {
    const session = buildSession('repo-2')
    await repos.sessions.put(session)
    const loaded = await repos.sessions.get(session.id)
    expect(loaded?.questionIds).toEqual(session.questionIds)
    expect(loaded?.questionIds).toHaveLength(30)
  })

  it('rejects a record that does not match the current schema instead of guessing', async () => {
    // Simulates a row written by a future/older build with a missing required field.
    await handle.db.put('sessions', {
      id: 'legacy',
      createdAt: '2020-01-01T00:00:00.000Z',
      questionIds: [],
      answers: {},
      status: 'draft',
    } as never)
    await expect(repos.sessions.get('legacy')).rejects.toThrow(/不符合当前 schema/)
  })

  it('lists sessions newest-first by updatedAt', async () => {
    const older = { ...buildSession('repo-3'), updatedAt: '2026-10-01T00:00:00.000Z' }
    const newer = { ...buildSession('repo-4'), updatedAt: '2026-10-05T00:00:00.000Z' }
    await repos.sessions.put(older)
    await repos.sessions.put(newer)
    const list = await repos.sessions.listAll()
    expect(list.map((session) => session.id)).toEqual([newer.id, older.id])
  })

  it('finds the latest unfinished session for the resume prompt', async () => {
    const draft = { ...buildSession('repo-5', false), updatedAt: '2026-10-06T00:00:00.000Z' }
    const finished = { ...buildSession('repo-6'), status: 'completed' as const }
    await repos.sessions.put(draft)
    await repos.sessions.put(finished)
    const found = await repos.sessions.findLatestIncomplete()
    expect(found?.id).toBe(draft.id)
  })

  it('deletes only the requested session', async () => {
    const a = buildSession('repo-7')
    const b = buildSession('repo-8')
    await repos.sessions.put(a)
    await repos.sessions.put(b)
    await repos.sessions.delete(a.id)
    expect(await repos.sessions.get(a.id)).toBeNull()
    expect(await repos.sessions.get(b.id)).not.toBeNull()
    expect(await repos.sessions.count()).toBe(1)
  })
})

describe('result repository', () => {
  it('stores a completed run and finds it by session', async () => {
    const session = buildSession('repo-9')
    const { result } = completeAssessment(bundle, session, {
      generatedAt: '2026-10-07T12:00:00.000Z',
    })
    await repos.results.put(result)
    const byId = await repos.results.get(result.id)
    const bySession = await repos.results.findBySession(session.id)
    expect(byId?.id).toBe(result.id)
    expect(bySession?.id).toBe(result.id)
    expect(byId?.dimensions).toHaveLength(16)
  })

  it('lists results newest-first', async () => {
    const a = completeAssessment(bundle, buildSession('repo-10'), {
      generatedAt: '2026-10-01T00:00:00.000Z',
    })
    const b = completeAssessment(bundle, buildSession('repo-11'), {
      generatedAt: '2026-10-09T00:00:00.000Z',
    })
    await repos.results.put(a.result)
    await repos.results.put(b.result)
    const list = await repos.results.listAll()
    expect(list[0]?.id).toBe(b.result.id)
  })
})

describe('settings repository', () => {
  it('returns defaults for a fresh database', async () => {
    const settings = await repos.settings.load()
    expect(settings.currentSessionId).toBeNull()
    expect(settings.provider.providerId).toBe('')
    expect(settings.provider.temperature).toBe(DEFAULT_APP_SETTINGS.provider.temperature)
  })

  it('patches without losing fields written earlier', async () => {
    await repos.settings.patch({ currentSessionId: 'sess-x' })
    await repos.settings.setProvider({ providerId: 'deepseek', model: 'deepseek-chat' })
    const settings = await repos.settings.load()
    expect(settings.currentSessionId).toBe('sess-x')
    expect(settings.provider.providerId).toBe('deepseek')
    expect(settings.provider.model).toBe('deepseek-chat')
    // A field never written keeps its default rather than becoming undefined.
    expect(settings.provider.transport).toBe(DEFAULT_APP_SETTINGS.provider.transport)
  })

  it('keeps the API key out of the settings record unless explicitly saved', async () => {
    await repos.settings.setProvider({ providerId: 'deepseek' })
    const settings = await repos.settings.load()
    const serialised = JSON.stringify(settings)
    expect(serialised).not.toContain('apiKey')
    expect(serialised).not.toContain('sk-')
    expect(await repos.settings.hasSecret()).toBe(false)
  })

  it('stores the secret only through the explicit opt-in path', async () => {
    await repos.settings.saveSecret('sk-test-not-a-real-key-000000')
    expect(await repos.settings.hasSecret()).toBe(true)
    const secret = await repos.settings.loadSecret()
    expect(secret?.apiKey).toBe('sk-test-not-a-real-key-000000')
    await repos.settings.clearSecret()
    expect(await repos.settings.hasSecret()).toBe(false)
  })
})

describe('report repository', () => {
  it('stores one report per result and replaces on regenerate', async () => {
    const session = buildSession('repo-12')
    const { result } = completeAssessment(bundle, session, {
      generatedAt: '2026-10-07T12:00:00.000Z',
    })
    await repos.reports.put({
      resultId: result.id,
      createdAt: '2026-10-07T12:00:00.000Z',
      provider: {
        providerId: 'mock',
        baseURL: 'mock://local',
        model: 'mock',
        transport: 'browser-direct',
      },
      versions: {
        prompt: 'report-prompt-v1',
        result: { questionPack: 'a@1', scoring: 'b@1', roleModel: 'c@1' },
      },
      content: 'first',
      durationMs: 1,
      isMock: true,
    })
    await repos.reports.put({
      resultId: result.id,
      createdAt: '2026-10-07T13:00:00.000Z',
      provider: {
        providerId: 'mock',
        baseURL: 'mock://local',
        model: 'mock',
        transport: 'browser-direct',
      },
      versions: {
        prompt: 'report-prompt-v1',
        result: { questionPack: 'a@1', scoring: 'b@1', roleModel: 'c@1' },
      },
      content: 'second',
      durationMs: 2,
      isMock: true,
    })
    const stored = await repos.reports.getByResult(result.id)
    expect(stored?.content).toBe('second')
    expect(await repos.reports.count()).toBe(1)
    const ids = await repos.reports.listResultIds()
    expect(ids.has(result.id)).toBe(true)
  })
})

describe('clearAll', () => {
  it('empties every store', async () => {
    await repos.sessions.put(buildSession('repo-13'))
    await repos.settings.patch({ currentSessionId: 'x' })
    await repos.settings.saveSecret('sk-abc')
    await handle.clearAll()
    expect(await repos.sessions.count()).toBe(0)
    expect(await repos.results.count()).toBe(0)
    expect(await repos.reports.count()).toBe(0)
    expect(await repos.settings.hasSecret()).toBe(false)
    const settings = await repos.settings.load()
    expect(settings.currentSessionId).toBeNull()
  })
})
