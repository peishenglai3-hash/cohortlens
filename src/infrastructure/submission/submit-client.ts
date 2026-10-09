import type { AssessmentResult, AssessmentSession } from '../../domain/schemas.ts'
import { SUBMISSION_FORMAT, SUBMISSION_FORMAT_VERSION } from '../../domain/submission.ts'
import type { ContactKind } from '../../domain/submission.ts'

/**
 * 提交客户端 —— 把一份本地结果送到审阅台。
 *
 * 三条设计约束，每一条都是为了"作答者只有一次机会、不该因为我们的疏忽白做一次测评"：
 *
 *   1. **幂等键在本地生成并保持稳定。** `clientSubmissionId` 一旦生成就存进会话，重试、刷新页面、
 *      关掉再打开，用的都是同一个键。没有这一条，一次网络抖动会让审阅台里出现两份一模一样的材料。
 *   2. **失败要能分辨。** "邀请码错了"和"网络断了"对作答者是完全不同的两件事：前者要联系发起方，
 *      后者只要再点一次。所以错误按 `kind` 分类，界面据此给出不同的下一步，而不是笼统的"提交失败"。
 *   3. **不自动重试。** 自动重试在服务端已经写入但响应丢失时是安全的（幂等键会挡住），
 *      但如果失败原因是邀请码无效，重试只是白等。把决定权交给作答者，并把上次的失败原因写清楚。
 */

export type SubmitErrorKind =
  | 'no_endpoint'
  | 'no_invite'
  | 'network'
  | 'timeout'
  | 'cors'
  | 'invalid'
  | 'invite'
  | 'server'
  | 'unknown'

export interface SubmitError {
  kind: SubmitErrorKind
  message: string
  /** 作答者下一步该做什么。不空。 */
  hint: string
  /** 技术细节，只在"展开"里显示。 */
  technical?: string
}

export interface SubmitSuccess {
  submissionId: string
  receivedAt: string
  /** `existing` = 这份材料之前已经提交过（重复提交被幂等键挡住），不是错误。 */
  status: 'created' | 'existing'
}

export interface SubmitInput {
  endpoint: string
  inviteCode: string
  contactKind: ContactKind
  contactValue: string
  clientSubmissionId: string
  session: AssessmentSession
  result: AssessmentResult
  /** 便于测试注入。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

export function buildSubmissionBody(input: SubmitInput) {
  const { session, result } = input
  return {
    format: SUBMISSION_FORMAT,
    clientSubmissionId: input.clientSubmissionId,
    inviteCode: input.inviteCode,
    contact: { kind: input.contactKind, value: input.contactValue.trim() },
    core: {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      submittedAt: new Date().toISOString(),
      assessedAt: session.completedAt ?? session.updatedAt,
      versions: {
        questionPackId: session.questionPackId,
        questionPackVersion: session.questionPackVersion,
        scoringVersion: session.scoringVersion,
        roleModelVersion: session.roleModelVersion,
      },
      session,
      result,
    },
    consent: true as const,
  }
}

/** 把服务端的错误码翻成作答者能看懂的东西。 */
function translateServerError(status: number, code: string, message: string): SubmitError {
  if (code.startsWith('invite_')) {
    return {
      kind: 'invite',
      message: message || '邀请码无法使用。',
      hint: '请回到发起方给你的那条链接，确认整条链接都复制完整了。',
      technical: `${status} ${code}`,
    }
  }
  if (code === 'rate_limited') {
    return {
      kind: 'server',
      message: '提交有点太频繁，服务器暂时没有接收。',
      hint: '等一分钟左右再点一次「提交给发起方」即可，你的作答还在本机。',
      technical: `${status} ${code}`,
    }
  }
  if (code === 'format_version_mismatch') {
    return {
      kind: 'invalid',
      message: '这份材料和你打开的这个页面版本不一致。',
      hint: '请刷新页面后重新提交。如果已经刷新过还是这样，请把这条信息发给发起方。',
      technical: `${status} ${code}`,
    }
  }
  if (code === 'invalid_submission') {
    return {
      kind: 'invalid',
      message: '服务器没有接受这份材料。',
      hint: '请把下面的技术细节复制给发起方；这是版本不匹配，不是你的作答有问题。',
      technical: `${status} ${code} :: ${message}`,
    }
  }
  if (code === 'origin_not_allowed') {
    return {
      kind: 'cors',
      message: '这个页面没有被允许向审阅台提交。',
      hint: '这是部署配置问题，请联系发起方；你的作答保存在本机，可以用「导出 JSON」先留一份。',
      technical: `${status} ${code}`,
    }
  }
  return {
    kind: 'server',
    message: message || '审阅台返回了一个错误。',
    hint: '可以稍后重试；如果一直失败，请把技术细节发给发起方。',
    technical: `${status} ${code}`,
  }
}

function networkError(error: unknown): SubmitError {
  const text = error instanceof Error ? error.message : String(error)
  if (/abort|timeout/i.test(text)) {
    return {
      kind: 'timeout',
      message: '提交超时，没有收到审阅台的回应。',
      hint: '有可能是网络慢。请再点一次「提交给发起方」——重复提交不会产生两份材料。',
      technical: text,
    }
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return {
      kind: 'cors',
      message: '没能连上审阅台。',
      hint: '可能是断网，也可能是审阅台还没允许这个页面地址。请检查网络后重试；仍然失败请联系发起方。',
      technical: text,
    }
  }
  return {
    kind: 'unknown',
    message: '提交时出现了一个没有预料到的问题。',
    hint: '可以重试一次；如果继续失败，请把技术细节发给发起方。你的作答还在本机。',
    technical: text,
  }
}

export async function submitAssessment(
  input: SubmitInput,
): Promise<{ ok: true; value: SubmitSuccess } | { ok: false; error: SubmitError }> {
  if (!input.endpoint) {
    return {
      ok: false,
      error: {
        kind: 'no_endpoint',
        message: '这个版本没有配置审阅台地址，无法提交。',
        hint: '你可以在本机完成测评，然后用「导出 JSON」把结果发给发起方。',
      },
    }
  }
  if (!input.inviteCode.trim()) {
    return {
      ok: false,
      error: {
        kind: 'no_invite',
        message: '缺少邀请码。',
        hint: '请使用发起方给你的完整链接打开这个页面；链接里带着邀请码。',
      },
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetchImpl(`${input.endpoint}/api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildSubmissionBody(input)),
      signal: controller.signal,
    })

    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }

    if (!response.ok) {
      const record = (body ?? {}) as { code?: string; message?: string }
      return {
        ok: false,
        error: translateServerError(
          response.status,
          record.code ?? 'unknown',
          record.message ?? '',
        ),
      }
    }

    const record = body as { submissionId?: string; receivedAt?: string; status?: string }
    return {
      ok: true,
      value: {
        submissionId: record.submissionId ?? '',
        receivedAt: record.receivedAt ?? new Date().toISOString(),
        status: record.status === 'existing' ? 'existing' : 'created',
      },
    }
  } catch (error) {
    return { ok: false, error: networkError(error) }
  } finally {
    clearTimeout(timeout)
  }
}
