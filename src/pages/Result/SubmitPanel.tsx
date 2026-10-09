import { useEffect, useState } from 'react'
import { useAppStore } from '../../app/store.ts'
import { resolveSubmissionConfig } from '../../config/submission-config.ts'
import {
  CONTACT_KINDS,
  SUBMISSION_NOTICE,
  contactHint,
  contactLooksUsable,
  type ContactKind,
} from '../../infrastructure/submission/types.ts'
import { formatDateTime } from '../../utils/format.ts'

/**
 * 提交面板 —— 把这份结果交给发起方。
 *
 * 界面上的三个决定，都是为了"作答者只有一次机会，不该因为界面的疏忽白做一次测评"：
 *
 *   1. **提交前把要上传什么逐条写出来**，而不是一个勾选框加一行小字。作答者上传的是自己关于政治—
 *      理论议题的自报立场与联系方式，这需要他明确知道。
 *   2. **提交成功之后不再显示提交按钮**，改成"已提交 + 时间 + 编号"。留在那里只会诱导重复提交。
 *   3. **失败时给出不同的下一步**。"邀请码不对"要联系发起方，"网络断了"只要再点一次——
 *      这两件事给出同一句"提交失败请重试"，等于把作答者丢在原地。
 */
export function SubmitPanel() {
  const session = useAppStore((state) => state.session)
  const result = useAppStore((state) => state.result)
  const settings = useAppStore((state) => state.settings)
  const submission = useAppStore((state) => state.submission)
  const submitToReview = useAppStore((state) => state.submitToReview)

  const [contactKind, setContactKind] = useState<ContactKind>('email')
  const [contactValue, setContactValue] = useState('')
  const [showTechnical, setShowTechnical] = useState(false)
  // Remembered per browser so a respondent who submits twice does not retype the same address.
  const storageKey = 'cohortlens.submission.contact'

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey)
      if (!saved) return
      const parsed = JSON.parse(saved) as { kind?: string; value?: string }
      if (parsed.kind === 'email' || parsed.kind === 'phone') setContactKind(parsed.kind)
      if (typeof parsed.value === 'string') setContactValue(parsed.value)
    } catch {
      // A blocked localStorage must not stop the panel from rendering.
    }
  }, [])

  const { enabled } = resolveSubmissionConfig(settings.reviewEndpoint)
  const valid = contactLooksUsable(contactKind, contactValue)
  const busy = submission.outcome === 'submitting'
  const done = submission.outcome === 'submitted' || submission.outcome === 'duplicate'

  const handleSubmit = async () => {
    if (!valid || busy) return
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ kind: contactKind, value: contactValue }),
      )
    } catch {
      // Non-fatal.
    }
    await submitToReview({ kind: contactKind, value: contactValue })
  }

  // No endpoint configured and nothing submitted: the build is local-only. Say so plainly instead
  // of showing a disabled button the respondent cannot act on.
  if (!enabled && !done) {
    return (
      <section className="card" data-testid="submit-section">
        <h2>提交给发起方</h2>
        <p className="hint">
          这个版本没有配置审阅台地址，所以不会上传任何内容。你的作答与结果只保存在这台设备上。
        </p>
        <p className="hint">如果需要把结果交给别人，请用下面的「导出 JSON」，把文件发给他。</p>
      </section>
    )
  }

  return (
    <section className="card" data-testid="submit-section">
      <h2>提交给发起方</h2>

      {done ? (
        <div className="submit-done" data-testid="submit-done">
          <p className="submit-done-title">
            {submission.outcome === 'duplicate'
              ? '这份材料之前已经提交过了，这次没有重复上传。'
              : '已提交给发起方。'}
          </p>
          <p className="hint">
            提交时间：{submission.submittedAt ? formatDateTime(submission.submittedAt) : '—'}
            {submission.submissionId ? ` · 编号 ${submission.submissionId.slice(0, 8)}` : ''}
          </p>
          <p className="hint">
            你本机的这份记录仍然保留，可以继续查看、导出或删除。如果想撤回提交，请直接联系发起方。
          </p>
        </div>
      ) : (
        <>
          <div className="submit-notice" data-testid="submit-notice">
            <h3>{SUBMISSION_NOTICE.title}</h3>
            <ul>
              {SUBMISSION_NOTICE.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <p className="hint">{SUBMISSION_NOTICE.withdrawal}</p>
          </div>

          <div className="field">
            <label htmlFor="contact-kind">联系方式类型</label>
            <select
              id="contact-kind"
              data-testid="contact-kind"
              value={contactKind}
              onChange={(event) => setContactKind(event.target.value as ContactKind)}
            >
              {CONTACT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind === 'email' ? '邮箱' : '手机号'}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="contact-value">{contactKind === 'email' ? '邮箱地址' : '手机号'}</label>
            <input
              id="contact-value"
              data-testid="contact-value"
              type={contactKind === 'email' ? 'email' : 'tel'}
              inputMode={contactKind === 'email' ? 'email' : 'tel'}
              autoComplete={contactKind === 'email' ? 'email' : 'tel'}
              placeholder={contactHint(contactKind)}
              value={contactValue}
              onChange={(event) => setContactValue(event.target.value)}
            />
            <p className="hint">
              发起方需要用它来把这份材料和你本人对上。除了它以外，不需要填写任何身份信息。
            </p>
          </div>

          <button
            type="button"
            className="primary"
            data-testid="submit-to-review"
            disabled={!valid || busy}
            onClick={handleSubmit}
          >
            {busy ? '正在提交…' : '提交给发起方'}
          </button>

          {!valid && contactValue.length > 0 && (
            <p className="hint" data-testid="contact-invalid">
              {contactKind === 'email'
                ? '这看起来不是一个完整的邮箱地址。'
                : '这看起来不是一个完整的手机号。'}
            </p>
          )}

          {submission.outcome === 'failed' && (
            <div className="submit-error" data-testid="submit-error">
              <p className="submit-error-message">{submission.error}</p>
              {submission.errorHint && <p className="hint">{submission.errorHint}</p>}
              {submission.errorTechnical && (
                <>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setShowTechnical((value) => !value)}
                  >
                    {showTechnical ? '收起技术细节' : '展开技术细节'}
                  </button>
                  {showTechnical && (
                    <pre className="submit-technical">{submission.errorTechnical}</pre>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/*
        The counts are shown so the respondent can tell *what* is being uploaded, not just that
        something is. `session`/`result` are guaranteed here by the caller, but the panel is written
        to survive their absence rather than crash a result page.
      */}
      {!done && session && result && (
        <details className="submit-scope">
          <summary>这次会上传：{Object.keys(session.answers).length} 道题的作答与完整结果</summary>
          <ul>
            <li>全部作答（题目 id 与选项 id，不含题目原文）</li>
            <li>结构化结果：B / C 层维度画像、角色适配、一致性与局限性说明</li>
            <li>A 层六部分的原始材料：自我认同、理论熟悉度、议题立场卡片、反身性</li>
            <li>你填写的联系方式</li>
          </ul>
          <p className="hint">不会上传：任何 API Key、浏览器信息、你的历史记录、其他测评的内容。</p>
        </details>
      )}
    </section>
  )
}
