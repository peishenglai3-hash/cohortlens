import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AssessmentResult, AssessmentSession } from '../../domain/schemas.ts'
import type { ReportRecord } from './report-repository.ts'
import type { AppSettings, ProviderSecret } from './settings-repository.ts'

/**
 * IndexedDB schema and connection.
 *
 * Engineering Bible §35 (IndexedDB stores ApplicationSettings / AssessmentSession /
 * AssessmentResult / QuestionPack metadata / Report history) and §36 (every schema change goes
 * through a migration, old data is never destroyed).
 *
 * `dbVersion` is explicit and every bump must add an `upgrade` step. The upgrade ladder below is
 * append-only: existing branches keep their data and new branches are created alongside.
 */

export const DB_NAME = 'cohortlens'
export const DB_VERSION = 1

export interface CohortLensDB extends DBSchema {
  sessions: {
    key: string
    value: AssessmentSession
    indexes: { by_updated: string; by_status: string }
  }
  results: {
    key: string
    value: AssessmentResult
    indexes: { by_session: string; by_generated: string }
  }
  /**
   * Non-secret application settings. API keys deliberately never live here; they are either
   * session-only (in memory) or in the dedicated `secrets` store behind an explicit opt-in.
   */
  settings: {
    key: string
    value: { key: string; value: AppSettings }
  }
  /** Only written when the user ticks "记住此设备" (Engineering Bible §31). */
  secrets: {
    key: string
    value: { key: string; value: ProviderSecret }
  }
  reports: {
    key: string
    value: ReportRecord
    indexes: { by_created: string }
  }
}

export function upgrade(
  db: IDBPDatabase<CohortLensDB>,
  oldVersion: number,
  _newVersion: number | null,
  _transaction: unknown,
): void {
  if (oldVersion < 1) {
    const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
    sessions.createIndex('by_updated', 'updatedAt')
    sessions.createIndex('by_status', 'status')

    const results = db.createObjectStore('results', { keyPath: 'id' })
    results.createIndex('by_session', 'sessionId')
    results.createIndex('by_generated', 'generatedAt')

    db.createObjectStore('settings', { keyPath: 'key' })
    db.createObjectStore('secrets', { keyPath: 'key' })

    const reports = db.createObjectStore('reports', { keyPath: 'resultId' })
    reports.createIndex('by_created', 'createdAt')
  }
}

export function openCohortLensDB(name: string = DB_NAME): Promise<IDBPDatabase<CohortLensDB>> {
  return openDB<CohortLensDB>(name, DB_VERSION, { upgrade })
}

export interface DatabaseHandle {
  readonly name: string
  readonly db: IDBPDatabase<CohortLensDB>
  close: () => void
  /** Wipes every store. Only reachable from an explicit user action in Settings. */
  clearAll: () => Promise<void>
}

export async function createDatabaseHandle(name: string = DB_NAME): Promise<DatabaseHandle> {
  const db = await openCohortLensDB(name)
  return {
    name,
    db,
    close: () => db.close(),
    clearAll: async () => {
      const stores = ['sessions', 'results', 'settings', 'secrets', 'reports'] as const
      const tx = db.transaction(stores, 'readwrite')
      await Promise.all(stores.map((store) => tx.objectStore(store).clear()))
      await tx.done
    },
  }
}

/** True when the runtime actually provides IndexedDB (guards SSR / older embedded webviews). */
export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}
