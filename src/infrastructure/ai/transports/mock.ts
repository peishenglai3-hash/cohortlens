import type { AITransport, ProviderConfig } from '../types.ts'

/**
 * MockTransport — a deterministic, offline stand-in for a real provider.
 *
 * Purpose (Local MVP brief §25): automated tests must never require a real API key. The mock
 * speaks the same OpenAI-compatible shapes as the real adapter, so the whole
 * Structured Result -> Provider -> Narrative Report -> Persistence chain is exercised for real
 * while staying hermetic.
 *
 * It is also reachable from the Settings UI as an explicit "本地示例（不联网）" option, so a user
 * can see the whole report flow without owning a key. Reports produced this way are marked
 * `isMock: true` and the UI labels them, so a synthetic report can never be mistaken for a
 * model's output.
 */

export interface MockTransportOptions {
  /** Force a specific failure so the error path can be tested. */
  failWith?:
    | 'invalid_api_key'
    | 'model_not_found'
    | 'cors_restriction'
    | 'network_error'
    | 'timeout'
    | 'quota_error'
    | 'provider_error'
  models?: string[]
  /** Extra latency, in ms. Zero by default so tests stay fast. */
  latencyMs?: number
}

export class MockTransport implements AITransport {
  readonly kind = 'browser-direct' as const
  readonly available = true
  private readonly options: MockTransportOptions

  constructor(options: MockTransportOptions = {}) {
    this.options = options
  }

  async request(
    _config: ProviderConfig,
    apiKey: string,
    request: { path: string; method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
  ): Promise<{ status: number; json: unknown; text: string }> {
    if (this.options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs))
    }

    const failure = this.options.failWith
    if (failure === 'network_error') throw new TypeError('Failed to fetch')
    if (failure === 'cors_restriction')
      throw new TypeError('Failed to fetch (CORS preflight blocked)')
    if (failure === 'timeout') throw new DOMException('The operation was aborted.', 'AbortError')
    if (failure === 'invalid_api_key') {
      return json(401, {
        error: { message: 'Incorrect API key provided', type: 'invalid_request_error' },
      })
    }
    if (failure === 'model_not_found') {
      return json(404, {
        error: { message: 'The model does not exist', type: 'invalid_request_error' },
      })
    }
    if (failure === 'quota_error') {
      return json(429, {
        error: { message: 'You exceeded your current quota', type: 'insufficient_quota' },
      })
    }
    if (failure === 'provider_error') {
      return json(500, { error: { message: 'internal server error', type: 'server_error' } })
    }

    if (!apiKey.trim()) {
      return json(401, { error: { message: 'No API key provided', type: 'invalid_request_error' } })
    }

    if (request.path.endsWith('/models')) {
      const models = this.options.models ?? ['mock-report-model', 'mock-report-model-mini']
      return json(200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', owned_by: 'cohortlens-mock' })),
      })
    }

    if (request.path.endsWith('/chat/completions')) {
      const content = this.renderMockReport(request.body)
      return json(200, {
        id: 'mock-completion',
        object: 'chat.completion',
        model: 'mock-report-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1200, completion_tokens: 640, total_tokens: 1840 },
      })
    }

    return json(404, { error: { message: `mock transport has no route for ${request.path}` } })
  }

  /**
   * Produce a report that is structurally correct and obviously synthetic: it restates only the
   * numbers present in the payload, keeps every mandated section, and states in the first line
   * that it is a local sample.
   */
  private renderMockReport(body: unknown): string {
    const payload = extractPayload(body)
    const lines: string[] = []
    lines.push('> 本报告由「本地示例 Provider」生成，不联网、不调用任何模型，仅用于验证报告链路。')
    lines.push('')
    lines.push('## 整体概况')
    lines.push(
      `本次结构化结果包含 ${payload.dimensions.length} 个维度与 ${payload.roleFits.length} 个角色适配项。作答一致性为 ${(
        payload.consistency.answerConsistency * 100
      ).toFixed(0)}%。以下描述只针对本次问卷呈现出的模式，不构成对人的判断。`,
    )
    lines.push('')
    lines.push('## 主要优势')
    for (const strength of payload.strengths.slice(0, 3)) lines.push(`- ${strength}`)
    lines.push('')
    lines.push('## 合作方式')
    const layerB = payload.dimensions.filter(
      (dimension) => dimension.layer === 'cooperation_behavior',
    )
    lines.push(
      layerB.length > 0
        ? layerB
            .map(
              (dimension) =>
                `- ${dimension.label}：本次 ${dimension.score} 分（${dimension.items} 道题支撑，置信度 ${(
                  dimension.confidence * 100
                ).toFixed(0)}%）`,
            )
            .join('\n')
        : '- 本次问卷未覆盖合作层维度，无法描述合作方式。',
    )
    lines.push('')
    lines.push('## 任务风格')
    const layerC = payload.dimensions.filter((dimension) => dimension.layer === 'skill_role')
    lines.push(
      layerC.length > 0
        ? layerC
            .map((dimension) => `- ${dimension.label}：本次 ${dimension.score} 分（自陈材料）`)
            .join('\n')
        : '- 本次问卷未覆盖技能层维度。',
    )
    lines.push('')
    lines.push('## 适合承担的工作类型')
    for (const role of payload.roleFits.slice(0, 3)) {
      lines.push(
        `- ${role.name}：加权适配 ${role.fitScore}，权重覆盖率 ${(role.coverage * 100).toFixed(0)}%`,
      )
    }
    lines.push('')
    lines.push('## 可能的磨合点')
    for (const area of payload.developmentAreas.slice(0, 3)) lines.push(`- ${area}`)
    lines.push('')
    lines.push('## 建议进一步人工了解的问题')
    lines.push('- 本次问卷中有多少个维度只由 1-2 道题支撑？请对照原始回答确认这些分数是否稳定。')
    lines.push('- 得分偏低的方向，是题目选择造成的，还是本人真实的工作方式？')
    if (payload.consistency.needsFurtherUnderstanding) {
      lines.push('- 回答一致性提示存在需要进一步了解的配对题，建议直接看原始回答。')
    }
    lines.push('')
    lines.push('## 测评局限性')
    for (const limitation of payload.limitations) lines.push(`- ${limitation}`)
    lines.push('')
    lines.push('## 边界声明')
    lines.push(payload.boundaries.map((boundary) => `- ${boundary}`).join('\n'))
    return lines.join('\n')
  }
}

function json(status: number, body: unknown): { status: number; json: unknown; text: string } {
  return { status, json: body, text: JSON.stringify(body) }
}

interface ExtractedPayload {
  dimensions: { label: string; layer: string; score: number; items: number; confidence: number }[]
  roleFits: { name: string; fitScore: number; coverage: number }[]
  strengths: string[]
  developmentAreas: string[]
  consistency: { answerConsistency: number; needsFurtherUnderstanding: boolean }
  limitations: string[]
  boundaries: string[]
}

/** Read the payload back out of the request body. Tolerant, because the body shape is the prompt's. */
function extractPayload(body: unknown): ExtractedPayload {
  const empty: ExtractedPayload = {
    dimensions: [],
    roleFits: [],
    strengths: [],
    developmentAreas: [],
    consistency: { answerConsistency: 1, needsFurtherUnderstanding: false },
    limitations: [],
    boundaries: [],
  }
  if (!body || typeof body !== 'object') return empty
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return empty
  const userMessage = messages.find((message) => (message as { role?: string }).role === 'user') as
    | { content?: string }
    | undefined
  const content = userMessage?.content
  if (typeof content !== 'string') return empty
  const parsed = parsePayloadJson(content)
  if (!parsed) return empty
  return {
    dimensions: parsed.dimensions ?? [],
    roleFits: parsed.roleFits ?? [],
    strengths: parsed.strengths ?? [],
    developmentAreas: parsed.developmentAreas ?? [],
    consistency: {
      answerConsistency: parsed.consistency?.answerConsistency ?? 1,
      needsFurtherUnderstanding: parsed.consistency?.needsFurtherUnderstanding ?? false,
    },
    limitations: parsed.limitations ?? [],
    boundaries: parsed.boundaries ?? [],
  }
}

function parsePayloadJson(content: string): Partial<ExtractedPayload> | null {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(content.slice(start, end + 1)) as Partial<ExtractedPayload>
  } catch {
    return null
  }
}
