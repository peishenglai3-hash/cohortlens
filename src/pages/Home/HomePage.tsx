import { Link } from 'react-router-dom'
import { PRIVACY_NOTICE, PRODUCT_CONFIG, RESULT_BOUNDARY_NOTICE } from '../../config/product.ts'
import { loadContentBundle } from '../../content/load-content.ts'
import { LAYERS } from '../../domain/schemas.ts'

const LAYER_LABELS: Record<(typeof LAYERS)[number], string> = {
  theory_value: '理论与问题理解',
  cooperation_behavior: '合作与行为',
  skill_role: '技能与角色',
}

export function HomePage() {
  const { pack, scoring, roleModel } = loadContentBundle()
  const quota = pack.assessmentPolicy.quota

  return (
    <main className="page">
      <h1>{PRODUCT_CONFIG.name}</h1>
      <p className="subtitle">{PRODUCT_CONFIG.subtitle}</p>
      <p>{PRODUCT_CONFIG.description}</p>

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
          <li>不生成单一总分，也不输出"录用/淘汰"建议。</li>
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
        <Link className="button primary" to="/assessment">
          开始测评
        </Link>
        <Link className="button" to="/about">
          关于本项目
        </Link>
      </div>
    </main>
  )
}
