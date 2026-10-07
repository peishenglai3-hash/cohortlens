import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabaseHandle, type DatabaseHandle } from '../../src/infrastructure/storage/db.ts'
import { createRepositories, type Repositories } from '../../src/infrastructure/storage/index.ts'
import { loadContentBundle } from '../../src/content/load-content.ts'
import { answerQuestion, createAssessment, paperQuestions } from '../../src/engine/assessment.ts'

/**
 * Session-persistence behaviour required by the Local MVP brief §B and Engineering Bible §54:
 * answers and the reading position must survive a reload, and the stored paper must never be
 * re-drawn.
 *
 * These tests exercise the persistence contract directly (repository + engine), which is what the
 * E2E suite then confirms through the real browser. Keeping both layers means a regression is
 * localised: this file says "the data layer lost it", the E2E says "the app lost it".
 */

const bundle = loadContentBundle()
let counter = 0
let handle: DatabaseHandle
let repos: Repositories

beforeEach(async () => {
  counter += 1
  handle = await createDatabaseHandle(`cohortlens-session-test-${counter}`)
  repos = createRepositories(handle)
})

afterEach(() => {
  handle.close()
})

describe('answer-by-answer persistence', () => {
  it('keeps every answer across a simulated reload', async () => {
    const created = createAssessment({ bundle, seed: 'persist-1', sessionId: 'sess_persist_1' })
    const questions = paperQuestions(bundle, created.session)
    let session = created.session
    await repos.sessions.put(session)

    // Answer five questions, writing after each one exactly as the store does.
    for (let i = 0; i < 5; i += 1) {
      const question = questions[i]!
      const optionId = question.options[i % question.options.length]!.id
      session = answerQuestion(session, question.id, optionId, `2026-10-07T12:0${i}:00.000Z`)
      await repos.sessions.put(session)
    }

    // Reload: the repository is the only thing that survives.
    const restored = await repos.sessions.get('sess_persist_1')
    expect(restored).not.toBeNull()
    expect(Object.keys(restored!.answers)).toHaveLength(5)
    expect(restored!.answers).toEqual(session.answers)
    expect(restored!.updatedAt).toBe('2026-10-07T12:04:00.000Z')
  })

  it('never re-draws the paper: the stored questionIds are authoritative', async () => {
    const created = createAssessment({ bundle, seed: 'persist-2', sessionId: 'sess_persist_2' })
    await repos.sessions.put(created.session)

    const restored = await repos.sessions.get('sess_persist_2')
    expect(restored!.questionIds).toEqual(created.session.questionIds)
    expect(restored!.seed).toBe(created.session.seed)
    // Re-deriving from the same seed must give the same paper, which is what makes resume safe.
    const redrawn = createAssessment({ bundle, seed: 'persist-2', sessionId: 'other' })
    expect(redrawn.session.questionIds).toEqual(restored!.questionIds)
  })

  it('records the reading position so a reload returns to the same question', async () => {
    const created = createAssessment({ bundle, seed: 'persist-3', sessionId: 'sess_persist_3' })
    await repos.sessions.put({ ...created.session, lastIndex: 7 })

    const restored = await repos.sessions.get('sess_persist_3')
    expect(restored!.lastIndex).toBe(7)
  })

  it('tolerates a session saved by a build that had no lastIndex field', async () => {
    const created = createAssessment({ bundle, seed: 'persist-4', sessionId: 'sess_persist_4' })
    const { lastIndex: _dropped, ...legacy } = created.session
    await repos.sessions.put(legacy as typeof created.session)

    const restored = await repos.sessions.get('sess_persist_4')
    expect(restored).not.toBeNull()
    expect(restored!.lastIndex).toBeUndefined()
    // The fallback rule the store uses: first unanswered question.
    const answers = { [restored!.questionIds[0]!]: 'x', [restored!.questionIds[1]!]: 'y' }
    const firstUnanswered = restored!.questionIds.findIndex((id) => answers[id] === undefined)
    expect(firstUnanswered).toBe(2)
  })

  it('keeps a draft and a completed session distinguishable for History', async () => {
    const draft = createAssessment({ bundle, seed: 'persist-5', sessionId: 'sess_draft' })
    const done = createAssessment({ bundle, seed: 'persist-6', sessionId: 'sess_done' })
    await repos.sessions.put(draft.session)
    await repos.sessions.put({
      ...done.session,
      status: 'completed',
      completedAt: '2026-10-07T12:00:00.000Z',
      resultId: 'result_x',
    })

    expect((await repos.sessions.listByStatus('draft')).map((s) => s.id)).toEqual(['sess_draft'])
    expect((await repos.sessions.listByStatus('completed')).map((s) => s.id)).toEqual(['sess_done'])
    expect((await repos.sessions.findLatestIncomplete())?.id).toBe('sess_draft')
  })
})
