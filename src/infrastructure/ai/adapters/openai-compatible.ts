import {
  buildReportPrompt,
  REPORT_PROMPT_VERSION,
  type ReportPromptLanguage,
} from '../prompts/report-prompt.ts'
import type {
  AITransport,
  ConnectionResult,
  ConnectionStatus,
  ModelInfo,
  ProviderConfig,
  ReportPayload,
  ReportResult,
} from '../types.ts'
import type { AIProvider } from '../types.ts'

/**
 * OpenAI-compatible provider adapter.
 *
 * These four new API error types (insufficient_quota, invalid_api_key, ...) are caught and
 * classified by `classifyError` instead of being surfaced raw, because Engineering Bible §34
 * forbids showing the user a bare "Failed to fetch".
 *
 * Everything here is transport-agnostic: the same adapter runs over BrowserDirectTransport, over
 * the future LocalBridge, and over the mock, which is why the mock can drive the real report path
 * in tests.
 */

export interface OpenAICompatibleOptions {
  id?: string
  /** Reported when a provider has no `/models` route. */
  modelListUnsupportedMessage?: string
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string

  constructor(
    private readonly transport: AITransport,
    options: OpenAICompatibleOptions = {},
  ) {
    this.id = options.id ?? 'openai-compatible'
  }

  get transportKind() {
    return this.transport.kind
  }

  async testConnection(config: ProviderConfig, apiKey: string): Promise<ConnectionResult> {
    if (!config.baseURL.trim()) {
      return {
        status: 'unknown_error',
        message: '还没有填写连接地址。',
        suggestion: '请在上方选择一个服务商，或展开高级设置填写 Base URL。',
      }
    }
    if (!apiKey.trim()) {
      return {
        status: 'invalid_api_key',
        message: '还没有填写 API Key。',
        suggestion: '粘贴你的 API Key 后再点一次测试连接。',
      }
    }
    if (!isValidHttpUrl(config.baseURL)) {
      return {
        status: 'unknown_error',
        message: '连接地址格式不正确。',
        suggestion: '地址需要以 http:// 或 https:// 开头，例如 https://api.example.com/v1。',
        technical: { endpoint: config.baseURL },
      }
    }
    if (!this.transport.available) {
      return {
        status: 'unsupported',
        message: '当前传输方式在此环境不可用。',
        suggestion: '请在设置中改回 Browser Direct，或等待未来桌面版本的 LocalBridge 支持。',
      }
    }

    try {
      const models = await this.listModels(config, apiKey)
      if (models.length === 0) {
        return {
          status: 'ok',
          message: '连接成功，但服务没有返回可用模型列表。',
          suggestion: '请在下方手动填写模型名称。',
          technical: { endpoint: `${config.baseURL.replace(/\/+$/, '')}/models` },
        }
      }
      if (config.model && !models.some((model) => model.id === config.model)) {
        return {
          status: 'model_not_found',
          message: `连接成功，但服务上没有找到模型「${config.model}」。`,
          suggestion: `可用模型例如：${models
            .slice(0, 3)
            .map((model) => model.id)
            .join('、')}。请重新选择。`,
          technical: { endpoint: `${config.baseURL.replace(/\/+$/, '')}/models` },
        }
      }
      return {
        status: 'ok',
        message: `连接成功，服务返回 ${models.length} 个可用模型。`,
        technical: { endpoint: `${config.baseURL.replace(/\/+$/, '')}/models` },
      }
    } catch (error) {
      return classifyError(error, config)
    }
  }

  async listModels(config: ProviderConfig, apiKey: string): Promise<ModelInfo[]> {
    const response = await this.transport.request(config, apiKey, {
      path: '/models',
      method: 'GET',
      timeoutMs: config.timeoutMs,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderHttpError(response.status, response.text, config)
    }
    const data = (response.json as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) {
      throw new ProviderHttpError(response.status, '响应中没有 data 数组', config)
    }
    return data
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const record = entry as { id?: unknown; owned_by?: unknown; created?: unknown }
        if (typeof record.id !== 'string') return null
        const info: ModelInfo = { id: record.id }
        if (typeof record.owned_by === 'string') info.ownedBy = record.owned_by
        if (typeof record.created === 'number') info.created = record.created
        return info
      })
      .filter((model): model is ModelInfo => model !== null)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async generateReport(
    config: ProviderConfig,
    apiKey: string,
    payload: ReportPayload,
  ): Promise<ReportResult> {
    if (!config.model.trim()) {
      throw new ProviderConfigurationError(
        '还没有选择模型。请先测试连接并选择模型，或在高级设置里手动填写。',
      )
    }
    const prompt = buildReportPrompt(payload, promptLanguage(payload))
    const started = Date.now()
    const response = await this.transport.request(config, apiKey, {
      path: '/chat/completions',
      method: 'POST',
      timeoutMs: config.timeoutMs,
      body: {
        model: config.model,
        temperature: config.temperature ?? 0.3,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      },
    })
    const durationMs = Date.now() - started
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderHttpError(response.status, response.text, config)
    }
    const choice = (response.json as { choices?: { message?: { content?: unknown } }[] } | null)
      ?.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ProviderResponseError('服务返回了空内容。可以重试一次，或换一个模型。')
    }
    const usage = (response.json as { usage?: Record<string, unknown> } | null)?.usage
    const result: ReportResult = { content, durationMs, model: config.model }
    if (usage) {
      const parsed: NonNullable<ReportResult['usage']> = {}
      if (typeof usage.prompt_tokens === 'number') parsed.promptTokens = usage.prompt_tokens
      if (typeof usage.completion_tokens === 'number')
        parsed.completionTokens = usage.completion_tokens
      if (typeof usage.total_tokens === 'number') parsed.totalTokens = usage.total_tokens
      result.usage = parsed
    }
    return result
  }
}

function promptLanguage(payload: ReportPayload): ReportPromptLanguage {
  // The payload carries a content version string; the report language follows the question bank
  // language, which for the frozen bank is Chinese.
  return payload.versions.questionBankLanguage === 'en' ? 'en' : 'zh'
}

export class ProviderHttpError extends Error {
  override readonly name = 'ProviderHttpError'
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly config: ProviderConfig,
  ) {
    super(`provider returned HTTP ${status}`)
  }
}

export class ProviderResponseError extends Error {
  override readonly name = 'ProviderResponseError'
}

export class ProviderConfigurationError extends Error {
  override readonly name = 'ProviderConfigurationError'
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Map a thrown value onto the diagnosis vocabulary. The raw message is kept only for the
 * collapsed technical panel and never includes the key.
 */
export function classifyError(error: unknown, config: ProviderConfig): ConnectionResult {
  const endpoint = config.baseURL.replace(/\/+$/, '') || undefined

  if (error instanceof ProviderConfigurationError) {
    return { status: 'unknown_error', message: error.message, technical: { endpoint } }
  }

  if (error instanceof ProviderResponseError) {
    return {
      status: 'provider_error',
      message: error.message,
      suggestion: '这通常是服务端或模型的问题，稍后重试或换一个模型。',
      technical: { endpoint, rawMessage: error.message },
    }
  }

  if (error instanceof ProviderHttpError) {
    return classifyHttpStatus(error)
  }

  // An AbortController abort surfaces as a DOMException named AbortError.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      status: 'timeout',
      message: '请求超时，服务没有在设定时间内返回。',
      suggestion: '检查网络，或在高级设置里把超时时间调大。',
      technical: { endpoint, rawMessage: 'AbortError' },
    }
  }

  if (error instanceof TypeError) {
    /**
     * A browser cannot distinguish "the host is unreachable" from "the host answered without CORS
     * headers" — both surface as an opaque TypeError. The UI therefore explains both possibilities
     * instead of guessing one, and points at the honest remedy: change service, or wait for the
     * desktop bridge. It never suggests standing up a proxy in between.
     */
    return {
      status: 'cors_restriction',
      message: '浏览器无法访问该地址：可能是网络不通，也可能是该服务不允许浏览器直接调用。',
      suggestion:
        '当前服务不允许浏览器直接连接。请更换支持浏览器调用的兼容服务，或等待未来桌面版本的 LocalBridge 支持。不要用临时代理服务器绕过这个限制。',
      technical: { endpoint, rawMessage: error.message },
    }
  }

  return {
    status: 'unknown_error',
    message: '连接失败，原因未知。',
    suggestion: '可以展开技术详情查看原始信息。',
    technical: {
      endpoint,
      rawMessage: error instanceof Error ? error.message : String(error),
    },
  }
}

function classifyHttpStatus(error: ProviderHttpError): ConnectionResult {
  const endpoint = error.config.baseURL.replace(/\/+$/, '') || undefined
  const body = error.bodyText.slice(0, 400)
  const technical = { httpStatus: error.status, endpoint, rawMessage: body }
  const lower = body.toLowerCase()

  if (error.status === 401 || error.status === 403) {
    return {
      status: 'invalid_api_key',
      message: 'API Key 无效或没有权限。',
      suggestion: '请确认 Key 没有输错、没有多余空格，并且这个 Key 有调用该模型的权限。',
      technical,
    }
  }
  if (error.status === 404 || lower.includes('model')) {
    if (lower.includes('model')) {
      return {
        status: 'model_not_found',
        message: '指定的模型不存在，或当前 Key 无权访问。',
        suggestion: '请重新测试连接获取可用模型列表，或换一个模型名称。',
        technical,
      }
    }
    return {
      status: 'unknown_error',
      message: '接口路径不存在。',
      suggestion: '请检查 Base URL 是否包含了正确的版本路径（例如 /v1）。',
      technical,
    }
  }
  if (error.status === 429) {
    return {
      status: 'quota_error',
      message: '额度不足或请求过于频繁。',
      suggestion: '请检查账户余额，或稍后重试。',
      technical,
    }
  }
  if (error.status >= 500) {
    return {
      status: 'provider_error',
      message: '服务端暂时不可用。',
      suggestion: '这是对方服务的问题，稍后重试即可。基础测评结果不受影响。',
      technical,
    }
  }
  if (error.status === 400) {
    return {
      status: 'provider_error',
      message: '请求被服务拒绝，可能是模型名称或参数不被支持。',
      suggestion: '换一个模型试试，或在高级设置里调整参数。',
      technical,
    }
  }
  return {
    status: 'unknown_error',
    message: `服务返回了未预期的状态码 ${error.status}。`,
    suggestion: '可以展开技术详情查看原始响应。',
    technical,
  }
}

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  ok: '连接正常',
  invalid_api_key: 'API Key 无效',
  model_not_found: '模型不存在',
  cors_restriction: '浏览器跨域限制',
  network_error: '网络错误',
  timeout: '请求超时',
  quota_error: '额度不足',
  provider_error: '服务端错误',
  unsupported: '当前环境不支持',
  unknown_error: '未知错误',
}

export { REPORT_PROMPT_VERSION }
