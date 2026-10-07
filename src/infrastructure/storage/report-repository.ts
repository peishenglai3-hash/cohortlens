import type { IDBPDatabase } from 'idb'
import type { CohortLensDB } from './db.ts'

/**
 * ReportRepository — Engineering Bible §35 "Report history", §19 of the Local MVP brief.
 *
 * A report is keyed by `resultId`: one AI narrative per structured result, so regenerating a
 * report replaces it instead of piling up duplicates. The raw provider response is stored
 * separately from the rendered text so a future prompt change cannot rewrite history.
 */

export interface ReportRecord {
  resultId: string
  createdAt: string
  /** Provider metadata only. The API key is never stored in this record. */
  provider: {
    providerId: string
    baseURL: string
    model: string
    transport: string
  }
  /** Prompt and payload versions, so a report can always be traced back to its inputs (§23). */
  versions: {
    prompt: string
    result: {
      questionPack: string
      scoring: string
      roleModel: string
    }
  }
  /** The narrative text shown to the user. */
  content: string
  /** Token/usage metadata when the provider returns it. */
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  /** Milliseconds the provider took, for diagnostics. */
  durationMs: number
  /** True when produced by the built-in mock provider rather than a real endpoint. */
  isMock: boolean
  /**
   * Forbidden phrases the boundary filter found and masked in the model's output. Recorded so a
   * masked report is visible as masked rather than silently passing as clean (ADR-007).
   */
  sanitizedViolations?: string[]
}

export class ReportRepository {
  constructor(private readonly db: IDBPDatabase<CohortLensDB>) {}

  async put(report: ReportRecord): Promise<void> {
    await this.db.put('reports', report)
  }

  async getByResult(resultId: string): Promise<ReportRecord | null> {
    const record = await this.db.get('reports', resultId)
    return record ?? null
  }

  async listAll(): Promise<ReportRecord[]> {
    const all = await this.db.getAll('reports')
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  /** resultIds that have a stored report, for the History list. */
  async listResultIds(): Promise<Set<string>> {
    const all = await this.db.getAllKeys('reports')
    return new Set(all)
  }

  async delete(resultId: string): Promise<void> {
    await this.db.delete('reports', resultId)
  }

  async count(): Promise<number> {
    return this.db.count('reports')
  }
}
