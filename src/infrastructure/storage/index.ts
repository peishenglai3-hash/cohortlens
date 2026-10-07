import { createDatabaseHandle, isIndexedDbAvailable, type DatabaseHandle } from './db.ts'
import { ResultRepository } from './result-repository.ts'
import { ReportRepository } from './report-repository.ts'
import { SessionRepository } from './session-repository.ts'
import { SettingsRepository } from './settings-repository.ts'

/**
 * Repository container.
 *
 * Components never touch IndexedDB directly: they go through the store, which goes through these
 * repositories. `repositories()` opens the database once and memoises the handle so a page
 * transition does not reopen it.
 */

export interface Repositories {
  sessions: SessionRepository
  results: ResultRepository
  settings: SettingsRepository
  reports: ReportRepository
  handle: DatabaseHandle
  close: () => void
}

export function createRepositories(db: DatabaseHandle): Repositories {
  return {
    sessions: new SessionRepository(db.db),
    results: new ResultRepository(db.db),
    settings: new SettingsRepository(db.db),
    reports: new ReportRepository(db.db),
    handle: db,
    close: () => db.close(),
  }
}

export interface RepositoryOptions {
  /** Override the database name. Tests use a fresh name so runs never share state. */
  databaseName?: string
}

export class PersistenceUnavailableError extends Error {
  override readonly name = 'PersistenceUnavailableError'
}

let cached: Promise<Repositories> | null = null
let cachedName: string | null = null

export async function getRepositories(options: RepositoryOptions = {}): Promise<Repositories> {
  const name = options.databaseName ?? 'cohortlens'
  if (!isIndexedDbAvailable()) {
    throw new PersistenceUnavailableError(
      '当前运行环境不提供 IndexedDB，无法保存测评进度。核心测评仍然可以在内存中完成，但刷新后会丢失。',
    )
  }
  if (cached && cachedName === name) return cached
  cachedName = name
  cached = createDatabaseHandle(name).then((handle) => createRepositories(handle))
  return cached
}

/** Drops the memoised handle. Used by the "清除本机数据" action and by tests. */
export async function resetRepositories(): Promise<void> {
  if (cached) {
    const repositories = await cached
    repositories.close()
  }
  cached = null
  cachedName = null
}

export * from './db.ts'
export * from './result-repository.ts'
export * from './report-repository.ts'
export * from './session-repository.ts'
export * from './settings-repository.ts'
