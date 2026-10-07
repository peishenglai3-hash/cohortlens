import { useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { optionsForQuestion, useAppStore } from '../../app/store.ts'
import { formatPercent } from '../../utils/format.ts'

/**
 * Question screen.
 *
 * Engineering Bible §54 (a refresh must not lose progress) and §55/§56 (semantic radios, visible
 * focus, large touch targets, single column at 375px).
 *
 * Answers are written to IndexedDB by the store on every change, so this component never has to
 * worry about saving: it renders state and dispatches intents.
 */
export function AssessmentPage() {
  const navigate = useNavigate()
  const session = useAppStore((state) => state.session)
  const questions = useAppStore((state) => state.questions)
  const result = useAppStore((state) => state.result)
  const index = useAppStore((state) => state.index)
  const bootStatus = useAppStore((state) => state.bootStatus)
  const bootError = useAppStore((state) => state.bootError)
  const answer = useAppStore((state) => state.answer)
  const next = useAppStore((state) => state.next)
  const previous = useAppStore((state) => state.previous)
  const finish = useAppStore((state) => state.finish)
  const startNew = useAppStore((state) => state.startNew)
  const saveState = useAppStore((state) => state.saveState)

  useEffect(() => {
    if (result) navigate('/result')
  }, [result, navigate])

  /**
   * Opening the assessment route with nothing in progress starts one.
   *
   * Without this the route is a dead end: the nav link "测评" and a bookmark of `#/assessment`
   * would both land on an empty state, even though the user's intent is unambiguous.
   *
   * The `useRef` latch is load-bearing. The guard `!session && !result` stays true until the first
   * `startNew()` resolves and publishes a session, and `startNew` is a fresh function identity on
   * every store update, so without a latch the effect can fire twice and draw *two* different
   * papers — the later write wins and the transcript the user was shown is quietly replaced. The
   * latch makes "auto-start once per mount" an invariant rather than a race.
   */
  const autoStarted = useRef(false)
  useEffect(() => {
    if (bootStatus !== 'ready') return
    if (autoStarted.current) return
    if (session || result) {
      autoStarted.current = true
      return
    }
    autoStarted.current = true
    void startNew()
  }, [bootStatus, session, result, startNew])

  const question = questions[index]
  const answeredCount = session ? Object.keys(session.answers).length : 0
  const options = useMemo(
    () => (question ? optionsForQuestion(question, session) : []),
    [question, session],
  )

  if (!session || questions.length === 0) {
    // Booting, or drawing a paper: both are a moment's wait, not an error.
    return (
      <main className="page">
        <h1>正在准备测评…</h1>
        <p className="hint">
          正在从题库分层随机抽题（15 / 9 / 6）。这一步完全在本机完成，不需要联网。
        </p>
        <div className="actions">
          <Link className="button" to="/history">
            打开历史记录
          </Link>
        </div>
      </main>
    )
  }

  if (!question) {
    return (
      <main className="page">
        <h1>题目索引越界</h1>
        <p>这通常意味着会话数据与题库不匹配。可以回到历史记录重新打开，或开始新测评。</p>
        <Link className="button" to="/history">
          打开历史记录
        </Link>
      </main>
    )
  }

  const chosen = session.answers[question.id]
  const isLast = index === questions.length - 1

  return (
    <main className="page page-assessment">
      {bootError && (
        <div className="banner banner-warn" role="status">
          {bootError}
        </div>
      )}

      <div className="progress">
        <div className="progress-text" data-testid="progress-text">
          第 {index + 1} / {questions.length} 题 · 已答 {answeredCount} 题（
          {formatPercent(answeredCount / questions.length)}）
        </div>
        <div className="progress-track" role="presentation">
          <div
            className="progress-fill"
            style={{ width: `${(answeredCount / questions.length) * 100}%` }}
          />
        </div>
        {/*
          Explicit save indicator: the answer is written to IndexedDB asynchronously, so "answered"
          and "saved" are different moments and the difference must be visible to the user.
        */}
        <p className="save-state" data-testid="save-state" data-save-state={saveState}>
          {saveState === 'saved'
            ? '进度已保存到本机'
            : saveState === 'saving'
              ? '正在保存…'
              : saveState === 'error'
                ? '保存失败：进度可能不会保留'
                : '尚未产生可保存的进度'}
        </p>
      </div>

      <section className="card question-card">
        <p className="question-meta">
          {question.id} ·{' '}
          {question.layer === 'theory_value'
            ? '理论与问题理解'
            : question.layer === 'cooperation_behavior'
              ? '合作与行为'
              : '技能与角色'}
        </p>
        <h1 className="question-prompt" data-testid="question-prompt">
          {question.prompt}
        </h1>

        <fieldset className="options">
          <legend className="visually-hidden">请选择一个选项</legend>
          {options.map((option, optionIndex) => (
            <label
              key={option.id}
              className={option.id === chosen ? 'option option-selected' : 'option'}
              data-testid={`option-${option.id}`}
            >
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={option.id === chosen}
                onChange={() => void answer(question.id, option.id)}
              />
              <span className="option-letter">{String.fromCharCode(65 + optionIndex)}</span>
              <span className="option-text">{option.text}</span>
            </label>
          ))}
        </fieldset>
      </section>

      <div className="actions actions-sticky">
        <button type="button" className="button" onClick={previous} disabled={index === 0}>
          上一题
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            if (
              window.confirm('放弃当前这次作答并重新抽题？已经答过的内容会被丢弃，且无法恢复。')
            ) {
              void startNew()
            }
          }}
          data-testid="abandon-and-restart"
        >
          放弃并重开
        </button>
        {isLast ? (
          <button
            type="button"
            className="button primary"
            onClick={() => void finish()}
            disabled={answeredCount === 0}
            data-testid="finish-assessment"
          >
            完成并查看结果
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            onClick={next}
            data-testid="next-question"
          >
            下一题
          </button>
        )}
      </div>

      <p className="hint">
        每选一个答案都会立即保存到本机浏览器。刷新或关掉浏览器后回到本页会继续，不会重新抽题。未作答的题目不计入维度分数，但会降低该维度的置信度。
      </p>
    </main>
  )
}
