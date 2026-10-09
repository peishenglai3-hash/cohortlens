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
  /**
   * 作答端向审阅台提交的地址覆盖值（A-layer V1.1 之后的审阅台功能）。
   *
   * 默认取自 `application.json` 的 `reviewEndpoint`，也就是随构建固化——公开链接发出去就自带后端，
   * 作答者什么都不用配。这个字段是给**同一份构建换后端**用的（换测试环境、换另一台 Worker）。
   *
   * 它不是密钥，所以放在 settings 而不是 secrets。
   */
  reviewEndpoint: string
  /**
   * 从邀请链接里带进来的邀请码。
   *
   * 存在这里而不是只留在内存里，是因为作答者会中途刷新页面——刷新后邀请码丢了，他点击提交只会
   * 得到"缺少邀请码"，然后不知道该做什么。邀请码本身不是敏感凭据（它只决定能否提交），
   * 但它确实是一种凭据，所以导出 JSON 时会被剥掉（见 `buildExportBundle`）。
   */
  inviteCode: string
  updatedAt: string
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  currentSessionId: null,
  provider: { ...DEFAULT_PROVIDER_CONFIG },
  reviewEndpoint: '',
  inviteCode: '',
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
