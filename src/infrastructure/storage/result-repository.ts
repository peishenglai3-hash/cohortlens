import type { IDBPDatabase } from 'idb'
import { assessmentResultSchema, type AssessmentResult } from '../../domain/schemas.ts'
import type { CohortLensDB } from './db.ts'

/**
 * ResultRepository — the Structured Result is the system's real core asset (Engineering Bible
 * §21), so it is stored as its own record keyed by result id and indexed by session id.
 */

export class ResultRepository {
  constructor(private readonly db: IDBPDatabase<CohortLensDB>) {}

  async put(result: AssessmentResult): Promise<void> {
    await this.db.put('results', result)
  }

  async get(id: string): Promise<AssessmentResult | null> {
    const raw = await this.db.get('results', id)
    if (raw === undefined) return null
    const parsed = assessmentResultSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `结果 ${id} 的数据不符合当前 schema，已拒绝加载：${parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join('.') + ': ' + issue.message)
          .join('；')}`,
      )
    }
    return parsed.data
  }

  /** Newest first. */
  async listAll(): Promise<AssessmentResult[]> {
    const all = await this.db.getAll('results')
    return all.sort((a, b) =>
      a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0,
    )
  }

  async listBySession(sessionId: string): Promise<AssessmentResult[]> {
    return this.db.getAllFromIndex('results', 'by_session', sessionId)
  }

  async findBySession(sessionId: string): Promise<AssessmentResult | null> {
    const list = await this.listBySession(sessionId)
    return list[0] ?? null
  }

  async delete(id: string): Promise<void> {
    await this.db.delete('results', id)
  }

  async count(): Promise<number> {
    return this.db.count('results')
  }
}
