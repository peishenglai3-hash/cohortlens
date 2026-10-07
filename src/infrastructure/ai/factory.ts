import rawPresets from '../../../content/providers/providers.json'
import { z } from 'zod'
import {
  DEFAULT_PROVIDER_CONFIG,
  type ProviderConfig,
  type TransportKind,
} from '../../config/provider-config.ts'
import { OpenAICompatibleProvider } from './adapters/openai-compatible.ts'
import { BrowserDirectTransport, LocalBridgeTransport } from './transports/browser-direct.ts'
import { MockTransport, type MockTransportOptions } from './transports/mock.ts'
import type { AIProvider, AITransport } from './types.ts'

/**
 * Provider registry and factory.
 *
 * Engineering Bible §25/§28/§32/§34. Presets come from `content/providers/providers.json`, so a
 * fork can add its own provider without touching code (§63 Config Driven).
 *
 * The two transport kinds are wired here and nowhere else. When the Tauri build lands, only this
 * file gains a case; the pages and the adapter stay unchanged.
 */

export const providerPresetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    baseURL: z.string(),
    protocol: z.enum(['openai-compatible', 'mock']),
    supportsModelList: z.boolean(),
    transport: z.enum(['browser-direct', 'local-bridge']),
    suggestedModels: z.array(z.string()),
    note: z.string(),
  })
  .strict()

export const providerPresetsFileSchema = z
  .object({
    schemaVersion: z.string().min(1),
    note: z.string(),
    defaultPresetId: z.string().min(1),
    providers: z.array(providerPresetSchema).min(1),
  })
  .strict()

export type ProviderPreset = z.infer<typeof providerPresetSchema>

export class ProviderPresetError extends Error {
  override readonly name = 'ProviderPresetError'
}

function loadPresets(): z.infer<typeof providerPresetsFileSchema> {
  const parsed = providerPresetsFileSchema.safeParse(rawPresets)
  if (!parsed.success) {
    throw new ProviderPresetError(
      `providers.json 校验失败：${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('；')}`,
    )
  }
  return parsed.data
}

export const PROVIDER_PRESETS_FILE = loadPresets()
export const PROVIDER_PRESETS: readonly ProviderPreset[] = PROVIDER_PRESETS_FILE.providers
export const DEFAULT_PRESET_ID = PROVIDER_PRESETS_FILE.defaultPresetId

export function findPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId)
}

/** `mock` is a real preset: it lets a user see the whole report flow with no key and no network. */
export function isMockPreset(providerId: string): boolean {
  return findPreset(providerId)?.protocol === 'mock'
}

export interface ApplyPresetResult {
  config: ProviderConfig
  preset: ProviderPreset | undefined
}

/**
 * Selecting a provider fills in base URL, transport and model-list strategy automatically, so the
 * ordinary user only ever touches two fields: API Key and Model (Engineering Bible §27/§28).
 */
export function applyPreset(
  preset: ProviderPreset,
  current: ProviderConfig = DEFAULT_PROVIDER_CONFIG,
): ApplyPresetResult {
  return {
    preset,
    config: {
      ...current,
      providerId: preset.id,
      transport: preset.transport as TransportKind,
      baseURL: preset.baseURL,
      supportsModelList: preset.supportsModelList,
      isCustom: preset.id === 'custom',
      // Keep a model the user already picked if the preset still lists it; otherwise take the
      // preset's first suggestion so the field is never mysteriously empty.
      model:
        current.model && preset.suggestedModels.includes(current.model)
          ? current.model
          : (preset.suggestedModels[0] ?? ''),
    },
  }
}

export function createTransport(
  kind: TransportKind,
  mockOptions?: MockTransportOptions,
): AITransport {
  if (mockOptions) return new MockTransport(mockOptions)
  if (kind === 'local-bridge') return new LocalBridgeTransport()
  return new BrowserDirectTransport()
}

export interface CreateProviderOptions {
  /** Force a transport. Tests inject a mock transport here. */
  transport?: AITransport
  /** Build the mock provider regardless of the configured preset. */
  mock?: MockTransportOptions
}

/**
 * Build the provider for a configuration. A `mock` preset routes to the mock transport so the
 * report chain can be exercised offline; every other preset uses the real OpenAI-compatible
 * adapter over whichever transport the config selects.
 */
export function createProvider(
  config: ProviderConfig,
  options: CreateProviderOptions = {},
): AIProvider {
  const transport =
    options.transport ??
    (options.mock
      ? new MockTransport(options.mock)
      : isMockPreset(config.providerId)
        ? new MockTransport()
        : createTransport(config.transport))
  return new OpenAICompatibleProvider(transport, { id: config.providerId || 'openai-compatible' })
}

/** True when the selected preset is known to refuse browser-direct access. */
export function presetWarnsAboutCors(preset: ProviderPreset | undefined): boolean {
  if (!preset) return false
  return /跨域|CORS|不允许浏览器/.test(preset.note)
}
