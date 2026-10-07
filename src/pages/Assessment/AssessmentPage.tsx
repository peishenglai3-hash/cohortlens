import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { optionsForQuestion, useAssessmentStore } from '../../app/store.ts'

/**
 * Question screen.
 *
 * Engineering Bible §55/§56: semantic radio inputs so keyboard selection works, a visible focus
 * ring, large touch targets, and a single-column layout that is usable at 375px.
 */
export function AssessmentPage() {
  const navigate = useNavigate()
  const {
    session,
    optionOrder,
    questions,
    index,
    result,
    error,
    start,
    answer,
    next,
    previous,
    finish,
  } = useAssessmentStore()

  useEffect(() => {
    if (!session) start()
  }, [session, start])

  useEffect(() => {
    if (result) navigate('/result')
  }, [result, navigate])

  if (error) {
    return (
      <main className="page">
        <h1>无法开始测评</h1>
        <pre className="error-detail">{error}</pre>
      </main>
    )
  }

  if (!session || questions.length === 0) {
    return (
      <main className="page">
        <h1>正在抽题…</h1>
        <p>系统正在按 15 / 9 / 6 的分层配额随机组卷。</p>
      </main>
    )
  }

  const question = questions[index]
  if (!question) {
    return (
      <main className="page">
        <h1>题目索引越界</h1>
      </main>
    )
  }

  const chosen = session.answers[question.id]
  const answered = Object.keys(session.answers).length
  const isLast = index === questions.length - 1
  const options = optionsForQuestion(question, optionOrder)

  return (
    <main className="page page-assessment">
      <div className="progress">
        <div className="progress-text">
          第 {index + 1} / {questions.length} 题 · 已答 {answered} 题
        </div>
        <div className="progress-track" role="presentation">
          <div
            className="progress-fill"
            style={{ width: `${(answered / questions.length) * 100}%` }}
          />
        </div>
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
        <h1 className="question-prompt">{question.prompt}</h1>

        <fieldset className="options">
          <legend className="visually-hidden">请选择一个选项</legend>
          {options.map((option, optionIndex) => (
            <label
              key={option.id}
              className={option.id === chosen ? 'option option-selected' : 'option'}
            >
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={option.id === chosen}
                onChange={() => answer(question.id, option.id)}
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
        {isLast ? (
          <button
            type="button"
            className="button primary"
            onClick={finish}
            disabled={answered === 0}
          >
            完成并查看结果
          </button>
        ) : (
          <button type="button" className="button primary" onClick={next}>
            下一题
          </button>
        )}
      </div>

      <p className="hint">
        答案只保存在当前页面内存中，刷新会重新开始（持久化在本切片尚未接入）。未作答的题目不会计入维度分数，但会降低该维度的置信度。
      </p>
    </main>
  )
}
