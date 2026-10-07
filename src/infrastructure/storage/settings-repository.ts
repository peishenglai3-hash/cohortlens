import type { IDBPDatabase } from 'idb'
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfig } from '../../config/provider-config.ts'
import type { CohortLensDB } from './db.ts'

/**
 * SettingsRepository — Engineering Bible §31 / §35.
 *
 * Two stores, and the split is the whole point:
 *   - `settings` holds non-secret configuration only (chosen provider, model, base URL, UI
 *     preferences). It is safe to persist and safe to export.
 *   - `secrets` holds the API key and is written **only** when the user explicitly ticks
 *     "记住此设备". By default the key lives in memory for the current session and is gone when
 *     the tab closes.
 *
 * Never claim that browser storage makes a long-lived key safe (§31: "不得宣传浏览器本地保存绝
 * 对安全"). The UI states plainly what is stored and where.
 */

export interface AppSettings {
  /** Id of the assessment in progress, so a returning user lands back on it. */
  currentSessionId: string | null
  provider: ProviderConfig
  updatedAt: string
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  currentSessionId: null,
  provider: { ...DEFAULT_PROVIDER_CONFIG },
  updatedAt: new Date(0).toISOString(),
}

export interface ProviderSecret {
  apiKey: string
  savedAt: string
}

export { DEFAULT_PROVIDER_CONFIG }
export type { ProviderConfig }

const SETTINGS_KEY = 'app'
const SECRET_KEY = 'provider'

export class SettingsRepository {
  constructor(private readonly db: IDBPDatabase<CohortLensDB>) {}

  async load(): Promise<AppSettings> {
    const record = await this.db.get('settings', SETTINGS_KEY)
    if (!record) return { ...DEFAULT_APP_SETTINGS, provider: { ...DEFAULT_PROVIDER_CONFIG } }
    // Merge rather than replace, so a settings object written by an earlier build keeps working
    // when a new field is added (Engineering Bible §36).
    return {
      ...DEFAULT_APP_SETTINGS,
      ...record.value,
      provider: { ...DEFAULT_PROVIDER_CONFIG, ...record.value.provider },
    }
  }

  async save(settings: AppSettings): Promise<void> {
    await this.db.put('settings', { key: SETTINGS_KEY, value: settings })
  }

  async patch(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load()
    const next: AppSettings = { ...current, ...patch, updatedAt: new Date().toISOString() }
    await this.save(next)
    return next
  }

  async setProvider(patch: Partial<ProviderConfig>): Promise<AppSettings> {
    const current = await this.load()
    return this.patch({ provider: { ...current.provider, ...patch } })
  }

  /** Only called after an explicit "记住此设备" opt-in. */
  async saveSecret(apiKey: string): Promise<void> {
    const secret: ProviderSecret = { apiKey, savedAt: new Date().toISOString() }
    await this.db.put('secrets', { key: SECRET_KEY, value: secret })
  }

  async loadSecret(): Promise<ProviderSecret | null> {
    const record = await this.db.get('secrets', SECRET_KEY)
    return record?.value ?? null
  }

  async clearSecret(): Promise<void> {
    await this.db.delete('secrets', SECRET_KEY)
  }

  async hasSecret(): Promise<boolean> {
    return (await this.db.count('secrets')) > 0
  }
}
