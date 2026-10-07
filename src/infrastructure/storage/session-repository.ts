import type { IDBPDatabase } from 'idb'
import { assessmentSessionSchema, type AssessmentSession } from '../../domain/schemas.ts'
import type { CohortLensDB } from './db.ts'

/**
 * SessionRepository — Engineering Bible §13 / §35 / §54.
 *
 * Only this module knows that sessions live in IndexedDB. React components talk to the store,
 * the store talks to repositories, and repositories talk to the database. §36 requires that a
 * stored session is validated on read: a record written by an older schema version is surfaced as
 * an error rather than silently producing a wrong paper.
 */

export class SessionRepository {
  constructor(private readonly db: IDBPDatabase<CohortLensDB>) {}

  async put(session: AssessmentSession): Promise<void> {
    await this.db.put('sessions', session)
  }

  async get(id: string): Promise<AssessmentSession | null> {
    const raw = await this.db.get('sessions', id)
    if (raw === undefined) return null
    const parsed = assessmentSessionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `会话 ${id} 的数据不符合当前 schema（可能来自旧版本），已拒绝加载以避免算出错误结果：${parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join('.') + ': ' + issue.message)
          .join('；')}`,
      )
    }
    return parsed.data
  }

  /** Newest first by `updatedAt`, which is what History shows (Engineering Bible §37). */
  async listAll(): Promise<AssessmentSession[]> {
    const all = await this.db.getAll('sessions')
    return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  }

  async listByStatus(status: AssessmentSession['status']): Promise<AssessmentSession[]> {
    return this.db.getAllFromIndex('sessions', 'by_status', status)
  }

  /** The session a returning user should be offered to resume: newest unfinished one. */
  async findLatestIncomplete(): Promise<AssessmentSession | null> {
    const drafts = await this.listByStatus('draft')
    if (drafts.length === 0) return null
    const sorted = drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return sorted[0] ?? null
  }

  async delete(id: string): Promise<void> {
    await this.db.delete('sessions', id)
  }

  async count(): Promise<number> {
    return this.db.count('sessions')
  }
}
