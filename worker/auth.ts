import type { Env } from './env.ts'

/**
 * 审阅台鉴权。
 *
 * 审阅台看的是**真人提交的政治—理论画像与联系方式**，是全项目最敏感的一个面。这里的做法是：
 *
 *   - 口令只以 secret 形式存在（`wrangler secret put ADMIN_TOKEN`），不进仓库、不进 wrangler.toml。
 *   - 客户端用 `Authorization: Bearer <token>` 提交，服务端做**定时安全**比较。
 *   - 比较用常量时间逐字节 XOR 累加，而不是 `===`。`===` 会在第一个不同的字节处返回，
 *     理论上可以被逐字节爆破口令；对一台公网可达的 Worker 来说，这个代价为零的修正是值得的。
 *   - 口令长度不足时**拒绝启动式地报错**：一个 4 字符的口令等于没有口令，而这不会有人发现，
 *     除非我们主动说出来。
 */

/** 口令最短长度。低于此值直接判定配置错误，而不是"照常工作但很弱"。 */
export const MIN_TOKEN_LENGTH = 24

export interface AuthResult {
  ok: boolean
  /** 失败原因码，用于响应体；不含任何口令信息。 */
  code: 'ok' | 'missing_header' | 'malformed_header' | 'invalid_token' | 'server_misconfigured'
  message: string
}

/** 常量时间字符串比较。长度不同直接返回 false（长度本身不是秘密）。 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

export function authenticate(request: Request, env: Env): AuthResult {
  const configured = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN : ''
  if (configured.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      code: 'server_misconfigured',
      message: `审阅台口令未配置或过短（要求至少 ${MIN_TOKEN_LENGTH} 个字符）。请运行：wrangler secret put ADMIN_TOKEN`,
    }
  }

  const header = request.headers.get('Authorization')
  if (!header) {
    return { ok: false, code: 'missing_header', message: '缺少 Authorization 头。' }
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match || !match[1]) {
    return {
      ok: false,
      code: 'malformed_header',
      message: 'Authorization 头格式应为 Bearer <token>。',
    }
  }

  if (!constantTimeEquals(match[1], configured)) {
    // 刻意不回显收到的值，也不说"差几个字符"。
    return { ok: false, code: 'invalid_token', message: '审阅台口令不正确。' }
  }
  return { ok: true, code: 'ok', message: 'ok' }
}

/**
 * 邀请码校验。
 *
 * 返回结构化结果而不是布尔值：调用方需要区分"码不存在"和"码用完了"，因为这两种要给作答者
 * 完全不同的提示——前者是他输错了，后者是让他联系发起方。
 */
export type InviteCheck =
  | { ok: true; id: string; label: string }
  | { ok: false; code: 'not_found' | 'inactive' | 'expired' | 'exhausted'; message: string }

export interface InviteRow {
  id: string
  code: string
  label: string
  max_uses: number
  uses: number
  active: number
  expires_at: string | null
}

export function checkInviteRow(row: InviteRow | null, now: string): InviteCheck {
  if (!row) {
    return {
      ok: false,
      code: 'not_found',
      message: '邀请码无效。请确认你复制的链接或编码是否完整。',
    }
  }
  if (row.active !== 1) {
    return { ok: false, code: 'inactive', message: '这个邀请码已被停用。请联系发起这次测评的人。' }
  }
  if (row.expires_at && row.expires_at <= now) {
    return {
      ok: false,
      code: 'expired',
      message: '这个邀请码已过期。请联系发起这次测评的人获取新的链接。',
    }
  }
  if (row.max_uses > 0 && row.uses >= row.max_uses) {
    return {
      ok: false,
      code: 'exhausted',
      message: '这个邀请码的可用次数已经用完。请联系发起这次测评的人。',
    }
  }
  return { ok: true, id: row.id, label: row.label }
}
