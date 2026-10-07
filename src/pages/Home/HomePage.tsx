import { Link } from 'react-router-dom'
import { PRIVACY_NOTICE, PRODUCT_CONFIG, RESULT_BOUNDARY_NOTICE } from '../../config/product.ts'
import { loadContentBundle } from '../../content/load-content.ts'
import { LAYERS } from '../../domain/schemas.ts'
import { useAppStore } from '../../app/store.ts'
import { formatDateTime } from '../../utils/format.ts'

const LAYER_LABELS: Record<(typeof LAYERS)[number], string> = {
  theory_value: '理论与问题理解',
  cooperation_behavior: '合作与行为',
  skill_role: '技能与角色',
}

export function HomePage() {
  const { pack, scoring, roleModel } = loadContentBundle()
  const quota = pack.assessmentPolicy.quota
  const session = useAppStore((state) => state.session)
  const history = useAppStore((state) => state.history)
  const startNew = useAppStore((state) => state.startNew)

  const inProgress = session && session.status === 'draft' ? session : null
  const answered = inProgress ? Object.keys(inProgress.answers).length : 0
  const recent = history.slice(0, 3)

  return (
    <main className="page">
      <h1>{PRODUCT_CONFIG.name}</h1>
      <p className="subtitle">{PRODUCT_CONFIG.subtitle}</p>
      <p>{PRODUCT_CONFIG.description}</p>

      {inProgress && (
        <section className="card notice" data-testid="resume-card">
          <h2>继续上次测评</h2>
          <p>
            你在 {formatDateTime(inProgress.updatedAt)} 开始了一次测评，已答 {answered} /{' '}
            {inProgress.questionIds.length} 题。题目组合已经固定，继续作答不会重新抽题。
          </p>
          <div className="actions">
            <Link className="button primary" to="/assessment" data-testid="resume-continue">
              继续作答（还剩 {inProgress.questionIds.length - answered} 题）
            </Link>
            <button
              type="button"
              className="button"
              data-testid="resume-restart"
              onClick={() => {
                if (
                  window.confirm('重新开始会丢弃当前这次未完成的作答，并重新随机抽题。确定吗？')
                ) {
                  void startNew()
                }
              }}
            >
              重新开始
            </button>
          </div>
          <p className="hint">「重新开始」需要确认，不会静默丢掉你已经答过的题。</p>
        </section>
      )}

      <section className="card">
        <h2>这次测评是什么</h2>
        <ul>
          <li>
            从 {pack.questions.length} 道题的题库中分层随机抽取{' '}
            {pack.assessmentPolicy.totalQuestions} 道题。
          </li>
          <li>
            三层信息预算：
            {LAYERS.map((layer) => `${LAYER_LABELS[layer]} ${quota[layer] ?? 0} 题`).join('，')}
            。这不是加权总分，而是三块各自独立的信息。
          </li>
          <li>全部计算在你自己的设备上完成，不联网也能得出结果。</li>
          <li>不生成单一总分，也不输出「录用 / 淘汰」建议。</li>
          <li>
            版本：题库 {pack.id}@{pack.version} · 评分 {scoring.id}@{scoring.version} · 角色模型{' '}
            {roleModel.id}@{roleModel.version}
          </li>
        </ul>
      </section>

      <section className="card notice">
        <h2>{PRIVACY_NOTICE.title}</h2>
        <ul>
          {PRIVACY_NOTICE.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <section className="card notice notice-boundary">
        <h2>{RESULT_BOUNDARY_NOTICE.title}</h2>
        <ul>
          {RESULT_BOUNDARY_NOTICE.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <div className="actions">
        {!inProgress && (
          <Link className="button primary" to="/assessment" data-testid="start-assessment">
            开始测评
          </Link>
        )}
        <Link className="button" to="/history">
          历史记录{history.length > 0 ? `（${history.length}）` : ''}
        </Link>
        <Link className="button" to="/settings">
          AI 报告设置
        </Link>
      </div>

      {recent.length > 0 && (
        <section className="card">
          <h2>最近记录</h2>
          <ul className="history-mini">
            {recent.map((entry) => (
              <li key={entry.session.id}>
                {formatDateTime(entry.session.updatedAt)} ·{' '}
                {entry.session.status === 'completed'
                  ? '已完成'
                  : `未完成（${entry.answered}/${entry.total}）`}
                {entry.hasReport ? ' · 有 AI 报告' : ''}
              </li>
            ))}
          </ul>
          <Link className="button" to="/history">
            打开历史记录
          </Link>
        </section>
      )}
    </main>
  )
}
