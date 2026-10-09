import type { AssessmentResult, AssessmentSession } from '../../domain/schemas.ts'
import {
  CONTACT_KINDS,
  SUBMISSION_FORMAT,
  SUBMISSION_FORMAT_VERSION,
  SUBMISSION_NOTICE,
} from '../../domain/submission.ts'

/**
 * 提交层对外暴露的类型与常量。
 *
 * 这里刻意**重新导出**领域契约里的常量，而不是让界面直接从 `src/domain/submission.ts` 取：
 * 界面需要知道的是"提交格式版本"和"可选的联系方式种类"，不需要也不应该能碰到
 * `ReviewSummary`（那是审阅台的东西）。一道窄接口比一个"什么都能 import"的模块更难用错。
 *
 * 同时，提交格式版本在客户端是**只读**的：它只能由领域契约决定。这样"客户端和服务端版本不一致"
 * 就只有一个可能的来源（构建时间不同），而不是两处各写一个数字然后漂移。
 */

export { CONTACT_KINDS, SUBMISSION_FORMAT, SUBMISSION_FORMAT_VERSION, SUBMISSION_NOTICE }
export type { ContactKind } from '../../domain/submission.ts'

export type SubmitOutcome = 'idle' | 'submitting' | 'submitted' | 'failed' | 'duplicate'

/**
 * 提交状态。
 *
 * `submittedAt` 与 `submissionId` 在提交成功后写进会话，所以刷新页面不会让作答者怀疑
 * "我到底交上了没有"——这是最容易让人重复提交、进而产生两份材料的地方。
 */
export interface SubmissionState {
  outcome: SubmitOutcome
  /** 服务端返回的提交 id。 */
  submissionId: string | null
  submittedAt: string | null
  /** 失败原因。成功时清空。 */
  error: string | null
  errorHint: string | null
  errorTechnical: string | null
}

export const IDLE_SUBMISSION_STATE: SubmissionState = {
  outcome: 'idle',
  submissionId: null,
  submittedAt: null,
  error: null,
  errorHint: null,
  errorTechnical: null,
}

/** 联系方式的基本形状校验。刻意宽松：我们不该替用户判断"这算不算一个真邮箱"。 */
export function contactLooksUsable(kind: (typeof CONTACT_KINDS)[number], value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3) return false
  if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
  // Phone: at least 7 digits once separators are removed.
  return trimmed.replace(/[^\d]/g, '').length >= 7
}

export function contactHint(kind: (typeof CONTACT_KINDS)[number]): string {
  return kind === 'email' ? '例如：you@example.com' : '例如：13800000000（可带 +86）'
}

export interface SubmissionContext {
  session: AssessmentSession
  result: AssessmentResult
}
