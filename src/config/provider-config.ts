/**
 * Shared provider configuration shape.
 *
 * This type lives in `config/` rather than in the AI layer or the storage layer, because both
 * need it and neither should depend on the other: the storage layer persists it, the AI layer
 * consumes it. Keeping one definition prevents the two copies drifting apart.
 *
 * The API key is deliberately absent. It travels as a separate argument everywhere (Engineering
 * Bible §30/§31), so it can never be persisted or exported together with configuration by accident.
 */

export type TransportKind = 'browser-direct' | 'local-bridge'

export interface ProviderConnectionConfig {
  /** Preset id from `content/providers/providers.json`, or `custom`. */
  providerId: string
  transport: TransportKind
  baseURL: string
  model: string
  /** Low by default (Engineering Bible §61). Editable only in Advanced mode. */
  temperature: number
  timeoutMs: number
}

export interface ProviderConfig extends ProviderConnectionConfig {
  /** True when the user is on the custom OpenAI-compatible path. */
  isCustom: boolean
  /** Whether the provider advertises a `/models` endpoint. */
  supportsModelList: boolean
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  providerId: '',
  transport: 'browser-direct',
  baseURL: '',
  model: '',
  temperature: 0.3,
  timeoutMs: 60000,
  isCustom: false,
  supportsModelList: true,
}
