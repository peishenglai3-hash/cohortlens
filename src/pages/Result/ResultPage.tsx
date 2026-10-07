import { Link } from 'react-router-dom'
import { useAssessmentStore } from '../../app/store.ts'
import { loadContentBundle } from '../../content/load-content.ts'
import { RESULT_BOUNDARY_NOTICE } from '../../config/product.ts'
import { LAYERS, type AssessmentResult, type Layer } from '../../domain/schemas.ts'
import { formatPercent } from '../../utils/ids.ts'

const LAYER_TITLES: Record<Layer, string> = {
  theory_value: 'A 层 · 理论与问题理解',
  cooperation_behavior: 'B 层 · 合作与行为',
  skill_role: 'C 层 · 技能与角色',
}

const LAYER_NOTES: Record<Layer, string> = {
  theory_value: '这一层不参与角色适配，也不得解释为政治立场、政治忠诚或意识形态纯度。',
  cooperation_behavior: '这一层是自陈材料，受社会赞许倾向影响，需要结合原始回答人工复核。',
  skill_role: '这一层是自陈的自我技能描述，不是能力测试结果。',
}

function ProfileBar({ score }: { score: number }) {
  return (
    <div className="profile-track" role="presentation">
      <div className="profile-fill" style={{ width: `${score}%` }} />
    </div>
  )
}

/**
 * Result screen — Engineering Bible §58.
 *
 * Profile cards + progress bars + role cards + collapsible evidence. Deliberately no leaderboard,
 * no red/green pass-fail, and no single total. §59 requires "这个判断主要来自哪些题目？" to be
 * answerable, so every dimension carries an expandable evidence list with the original prompt and
 * the respondent's own choice.
 */
export function ResultPage() {
  const { result, session } = useAssessmentStore()
  const { pack } = loadContentBundle()

  if (!result || !session) {
    return (
      <main className="page">
        <h1>还没有结果</h1>
        <p>请先完成一次测评。当前切片的结果保存在内存中，刷新页面后需要重新测评。</p>
        <Link className="button primary" to="/assessment">
          去测评
        </Link>
      </main>
    )
  }

  const questionById = new Map(pack.questions.map((question) => [question.id, question]))
  const optionText = (questionId: string, optionId: string): string => {
    const question = questionById.get(questionId)
    const option = question?.options.find((candidate) => candidate.id === optionId)
    return option?.text ?? '(未作答)'
  }
  const detail = (value: AssessmentResult): string =>
    value.dimensions
      .map((dimension) => `${dimension.label} ${dimension.normalizedScore}`)
      .join(' · ')

  return (
    <main className="page page-result">
      <h1>结构化结果</h1>
      <p className="subtitle">第一阶段全部在你的设备上完成，未调用任何 LLM。</p>

      <section className="card">
        <h2>本次记录</h2>
        <dl className="meta-list">
          <div>
            <dt>会话 ID</dt>
            <dd>{session.id}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{result.generatedAt}</dd>
          </div>
          <div>
            <dt>题库版本</dt>
            <dd>{result.versions.questionPack}</dd>
          </div>
          <div>
            <dt>评分版本</dt>
            <dd>{result.versions.scoring}</dd>
          </div>
          <div>
            <dt>角色模型版本</dt>
            <dd>{result.versions.roleModel}</dd>
          </div>
          <div>
            <dt>作答情况</dt>
            <dd>
              已答 {result.evidence.length} / {session.questionIds.length} 题
            </dd>
          </div>
        </dl>
        <p className="hint">摘要：{detail(result)}</p>
      </section>

      <section className="card notice notice-boundary">
        <h2>{RESULT_BOUNDARY_NOTICE.title}</h2>
        <ul>
          {RESULT_BOUNDARY_NOTICE.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      {LAYERS.map((layer) => {
        const rows = result.dimensions.filter((dimension) => dimension.layer === layer)
        if (rows.length === 0) return null
        return (
          <section className="card" key={layer}>
            <h2>{LAYER_TITLES[layer]}</h2>
            <p className="hint">{LAYER_NOTES[layer]}</p>
            <ul className="profile-list">
              {rows.map((dimension) => (
                <li key={dimension.id} className="profile-row">
                  <div className="profile-head">
                    <span className="profile-label">{dimension.label}</span>
                    <span className="profile-score">{dimension.normalizedScore}</span>
                  </div>
                  <ProfileBar score={dimension.normalizedScore} />
                  <div className="profile-meta">
                    区间：{dimension.band} · 原始分 {dimension.rawScore}/{dimension.maxPossible} ·
                    题量 {dimension.answeredItems}/{dimension.expectedItems} · 置信度{' '}
                    {formatPercent(dimension.confidence)}
                  </div>
                  {(dimension.warnings ?? []).length > 0 && (
                    <ul className="warning-list">
                      {(dimension.warnings ?? []).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <details className="evidence">
                    <summary>这个判断主要来自哪些题目？</summary>
                    <ul>
                      {dimension.evidenceQuestionIds.map((questionId) => {
                        const question = questionById.get(questionId)
                        const chosenOptionId = session.answers[questionId]
                        return (
                          <li key={questionId}>
                            <p className="evidence-prompt">
                              <strong>{questionId}</strong>{' '}
                              {question?.prompt ?? '(题目已不在题库中)'}
                            </p>
                            <p className="evidence-answer">
                              你的作答：
                              {chosenOptionId ? optionText(questionId, chosenOptionId) : '(未作答)'}
                              {' · '}本维度信号：
                              {result.evidence.find((item) => item.questionId === questionId)
                                ?.signal ?? '—'}{' '}
                              /{' '}
                              {result.evidence.find((item) => item.questionId === questionId)
                                ?.maxSignal ?? '—'}
                            </p>
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      <section className="card">
        <h2>角色适配（只使用 B / C 层维度）</h2>
        <p className="hint">
          下面的分数由合作与技能层维度加权得到，权重里不含任何理论层维度，也不是在判断"你是谁"。
        </p>
        <ul className="role-list">
          {result.roleFits.map((fit) => (
            <li key={fit.roleId} className="role-card">
              <div className="profile-head">
                <span className="profile-label">{fit.name}</span>
                <span className="profile-score">{fit.fitScore}</span>
              </div>
              <ProfileBar score={fit.fitScore} />
              <p className="role-phrase">{fit.phrase}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>回答一致性与稳定度</h2>
        <p className="hint">
          这一节只描述答卷内部的方向差异，不是"真实性"评分，也不能推出任何关于人的结论。
        </p>
        <dl className="meta-list">
          <div>
            <dt>回答一致性</dt>
            <dd>{formatPercent(result.consistency.answerConsistency)}</dd>
          </div>
          <div>
            <dt>最高档重复选择率</dt>
            <dd>{formatPercent(result.consistency.extremeRepeatRate)}</dd>
          </div>
          <div>
            <dt>需要进一步了解</dt>
            <dd>{result.consistency.needsFurtherUnderstanding ? '是' : '否'}</dd>
          </div>
        </dl>
        <ul className="finding-list">
          {result.consistency.findings.map((finding) => (
            <li key={finding.groupId}>
              <strong>
                {finding.groupId} · {finding.label}
              </strong>
              <span className="finding-questions">{finding.questionIds.join(' / ')}</span>
              <p>{finding.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>当前回答中较明显的方面</h2>
        <ul>
          {result.strengths.map((strength) => (
            <li key={strength}>{strength}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>可能需要更多信息的方向</h2>
        <ul>
          {result.developmentAreas.map((area) => (
            <li key={area}>{area}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>抽题引擎阶段实际状态</h2>
        <p className="hint">未激活的阶段如实标注，不假装执行过。</p>
        <ul className="stage-list">
          {result.samplerStages.map((stage) => (
            <li key={stage.stage}>
              <span className={stage.active ? 'tag tag-active' : 'tag'}>
                {stage.active ? '已激活' : '未激活'}
              </span>
              <code>{stage.stage}</code> {stage.reason}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>测评局限性</h2>
        <ul>
          {result.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>

      <div className="actions">
        <Link className="button" to="/assessment">
          再测一次
        </Link>
        <button type="button" className="button" onClick={() => window.print()}>
          打印 / 另存为 PDF
        </button>
        <Link className="button" to="/">
          回首页
        </Link>
      </div>
      <p className="hint">
        JSON 导出与历史记录尚未接入本切片：引擎结果已经是可 JSON 序列化的结构化对象（见
        exports/demo-assessment-result.json 与 npm run demo:assessment），落盘层是下一步工作。
      </p>
    </main>
  )
}
