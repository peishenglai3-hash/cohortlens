/**
 * Provider layer contracts.
 *
 * Engineering Bible §25 (AIProvider), §26 (ProviderConfig), §32 (transport abstraction),
 * §33 (LocalBridge reserved for a future Tauri build).
 *
 * The split matters:
 *   - `AIProvider` owns protocol semantics: how to test a connection, list models, produce a report.
 *   - `AITransport` owns "how a request actually leaves the app" and "where the key lives".
 *
 * The API key is deliberately NOT part of `ProviderConfig`. It lives in a separate secret argument
 * so it cannot be accidentally persisted, exported, or logged together with configuration
 * (Engineering Bible §30, §31, §53).
 */

import type { ProviderConnectionConfig, TransportKind } from '../../config/provider-config.ts'

export type { TransportKind }

/**
 * The AI layer consumes the shared connection config. Temperature and timeout are part of it
 * because they are protocol parameters, while `isCustom` / `supportsModelList` stay in the storage
 * layer where they are presentation concerns.
 */
export type ProviderConfig = ProviderConnectionConfig

/** Connection diagnosis vocabulary required by Engineering Bible §34 and the Local MVP brief §17. */
export type ConnectionStatus =
  | 'ok'
  | 'invalid_api_key'
  | 'model_not_found'
  | 'cors_restriction'
  | 'network_error'
  | 'timeout'
  | 'quota_error'
  | 'provider_error'
  | 'unsupported'
  | 'unknown_error'

export interface ConnectionResult {
  status: ConnectionStatus
  /** Human-readable Chinese sentence for the normal UI. */
  message: string
  /** What the user can do next. Empty when nothing useful can be suggested. */
  suggestion?: string
  /** Populated only for the collapsed "技术详情" panel. Never contains the key. */
  technical?: {
    httpStatus?: number
    endpoint?: string | undefined
    rawMessage?: string | undefined
  }
}

export interface ModelInfo {
  id: string
  ownedBy?: string
  created?: number
}

export interface ReportUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface ReportResult {
  content: string
  usage?: ReportUsage
  durationMs: number
  model: string
}

export interface AITransport {
  readonly kind: TransportKind
  /** True when this transport can run in a plain browser tab with no native host. */
  readonly available: boolean
  request(
    config: ProviderConfig,
    apiKey: string,
    request: {
      path: string
      method: 'GET' | 'POST'
      body?: unknown
      timeoutMs: number
    },
  ): Promise<{ status: number; json: unknown; text: string }>
}

export interface AIProvider {
  readonly id: string
  readonly transportKind: TransportKind
  testConnection(config: ProviderConfig, apiKey: string): Promise<ConnectionResult>
  listModels?(config: ProviderConfig, apiKey: string): Promise<ModelInfo[]>
  generateReport(
    config: ProviderConfig,
    apiKey: string,
    payload: ReportPayload,
  ): Promise<ReportResult>
}

/**
 * The sanitized payload handed to a provider.
 *
 * Engineering Bible §60: never send a name, contact details, IP, browser info, the full history,
 * or the raw answer sheet. The payload is built by an explicit whitelist in
 * `buildReportPayload`, not by deleting fields from the result — a whitelist cannot leak a field
 * that a future schema version adds.
 */
export interface ReportPayload {
  /** Prompt version this payload is meant to be used with. */
  promptVersion: string
  /** Which content versions produced the structured result being described. */
  versions: {
    questionPack: string
    scoring: string
    roleModel: string
    /** Two-letter language of the question bank, so the report is written in the same language. */
    questionBankLanguage: string
  }
  dimensions: ReportPayloadDimension[]
  roleFits: ReportPayloadRole[]
  /** Pre-computed phrasing the engine already produced, so the model does not invent new numbers. */
  strengths: string[]
  developmentAreas: string[]
  consistency: {
    answerConsistency: number
    extremeRepeatRate: number
    needsFurtherUnderstanding: boolean
    notes: string[]
  }
  limitations: string[]
  /** Explicit instruction echo: the model is told what it must not do. */
  boundaries: string[]
}

export interface ReportPayloadDimension {
  id: string
  label: string
  layer: 'theory_value' | 'cooperation_behavior' | 'skill_role'
  /** Rounded 0-100 score inside this question bank only. */
  score: number
  band: string
  /** How many items supported it, so the model can hedge honestly. */
  items: number
  confidence: number
  /** Stable question ids only — never the respondent's chosen option text (§60). */
  evidenceQuestionIds: string[]
}

export interface ReportPayloadRole {
  roleId: string
  name: string
  fitScore: number
  coverage: number
}
