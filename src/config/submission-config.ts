import appConfigRaw from '../../application.json'

/**
 * 提交（审阅台）配置 —— 作答端往哪里提交。
 *
 * 三层的取值顺序是刻意的：
 *
 *   1. `application.json` 里的 `reviewEndpoint`：**随构建固化**，所以发出去的公开链接天生就知道
 *      该提交到哪里。作答者不需要配置任何东西——这是"发给一个陌生人，他打开就能用"的前提。
 *   2. 设置页里的覆盖值：给同一个构建换后端用（换测试环境、换另一台 Worker）。
 *   3. 都没有 → 提交功能整体关闭，界面明确说"本次测评不需要提交"。
 *
 * 不把 endpoint 做成必填是有意的：这个应用首先是**本地优先**的，本地把整套流程跑完（含导出 JSON）
 * 必须在不依赖任何后端的情况下成立。后端是可选的一层，不是前提。
 */

const appConfig = appConfigRaw as {
  name: string
  shortName: string
  description: string
  reviewEndpoint?: string
}

/** 构建期固化的提交地址。空串表示这个构建不带后端。 */
export const BUILD_REVIEW_ENDPOINT: string = (appConfig.reviewEndpoint ?? '').trim()

export interface SubmissionConfig {
  endpoint: string
  enabled: boolean
}

/**
 * 规范化用户手填的地址。
 *
 * 只做去空白与去尾斜杠，不做"补 https"这类猜测：把 `review.example.com` 悄悄补成
 * `https://review.example.com` 看起来友好，但当用户其实想写 `http://10.0.0.5:8787` 时，
 * 这个猜测会把他指向一个不存在的地址，而错误信息完全指不到原因。宁可直接拒绝并要求写全。
 */
export function normaliseEndpoint(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '')
}

export function resolveSubmissionConfig(override?: string | null): SubmissionConfig {
  const endpoint = normaliseEndpoint(override) || BUILD_REVIEW_ENDPOINT
  return { endpoint, enabled: endpoint.length > 0 }
}

/** 校验用户填写的地址是否可用。返回 `null` 表示没问题。 */
export function validateEndpoint(raw: string): string | null {
  const value = normaliseEndpoint(raw)
  if (value.length === 0) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return '地址格式不对。请写完整地址，例如 https://cohortlens-review.你的账号.workers.dev'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return '只支持 http 或 https 地址。'
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return '出于安全考虑，非本机地址必须使用 https。'
  }
  return null
}

/** 从 `#/assessment?invite=XXXX` 这类 hash 路由里取邀请码。 */
export function readInviteFromHash(hash: string): string | null {
  const queryStart = hash.indexOf('?')
  if (queryStart < 0) return null
  const params = new URLSearchParams(hash.slice(queryStart + 1))
  const invite = params.get('invite') ?? params.get('code')
  const trimmed = (invite ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}
