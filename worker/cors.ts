import type { Env } from './env.ts'

/**
 * 跨域（CORS）与来源校验。
 *
 * 作答端和 Worker 不在同一个源上（Pages 一个域名、Worker 一个域名），所以提交接口必须支持跨域。
 * 这里刻意**不用** `Access-Control-Allow-Origin: *`：
 *
 *   - 提交接口带 `Content-Type: application/json`，属于非简单请求，浏览器会先发预检。
 *   - 预检通过之后，真正的限制来自"谁被允许拿到响应"。配 `*` 意味着任何网站都能代表你的
 *     作答者向这台 Worker 提交数据；配白名单意味着只有你自己的作答端可以。
 *
 * 白名单是**精确匹配**（区分 scheme/host/port），不做后缀匹配：`evil-example.com` 不能靠
 * `endsWith('example.com')` 混进来。
 */

/** 解析 `ALLOWED_ORIGINS`。空值返回空数组，表示"只允许同源"。 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0)
}

export interface CorsDecision {
  allowed: boolean
  /** 命中时回填的 `Access-Control-Allow-Origin` 值。 */
  origin: string | null
}

export function decideCors(requestOrigin: string | null, env: Env): CorsDecision {
  if (!requestOrigin) return { allowed: true, origin: null }
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS)
  if (allowed.length === 0) return { allowed: false, origin: null }
  if (allowed.includes(requestOrigin)) return { allowed: true, origin: requestOrigin }
  return { allowed: false, origin: null }
}

/**
 * 白名单为空时的自检提示。
 *
 * 这是一个**很容易部署错的配置**：忘了设 `ALLOWED_ORIGINS`，提交接口会安静地对所有跨域请求
 * 说不，而前台只会显示"提交失败"。所以部署检查与 Worker 的 `/api/health` 都要能报出这一条。
 */
export function missingAllowedOrigins(env: Env): string | null {
  if (parseAllowedOrigins(env.ALLOWED_ORIGINS).length > 0) return null
  return (
    'ALLOWED_ORIGINS 未配置：作答端与本 Worker 不同源时，所有提交都会被拒绝。' +
    '请把它设为作答端的来源，例如 https://your-app.pages.dev'
  )
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return headers
}
