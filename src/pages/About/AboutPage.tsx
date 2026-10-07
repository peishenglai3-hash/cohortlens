import { Link } from 'react-router-dom'
import { PRODUCT_CONFIG } from '../../config/product.ts'
import { REQUIRED_FORBIDDEN_LANGUAGE } from '../../domain/validation.ts'
import { auditRoleModel } from '../../engine/role-fit.ts'
import { loadContentBundle } from '../../content/load-content.ts'

export function AboutPage() {
  const { pack, scoring, roleModel } = loadContentBundle()
  const audit = auditRoleModel(roleModel, scoring)

  return (
    <main className="page">
      <h1>关于 {PRODUCT_CONFIG.name}</h1>

      <section className="card">
        <h2>这个工具做什么</h2>
        <p>
          把一场高度模糊、容易凭印象完成的人际甄别过程，转化为一个结构化、可解释、可回看、可纠偏的人机协同过程。
          结构化本身也不能被误认为真理，所以系统始终保留原始答案、评分版本、题库版本、算法版本、证据来源和人工判断权。
        </p>
      </section>

      <section className="card">
        <h2>这个工具不做什么</h2>
        <ul>
          <li>不判断政治忠诚度、政治可靠性或意识形态纯度。</li>
          <li>不输出录用、淘汰或"是不是自己人"的结论。</li>
          <li>不生成"撒谎概率""欺骗指数""真实性评分"。</li>
          <li>不产生单一总分；输出的是维度画像（Profile Vector）。</li>
          <li>不把结果当成关于某个人的事实陈述。</li>
        </ul>
      </section>

      <section className="card">
        <h2>当前内容版本</h2>
        <dl className="meta-list">
          <div>
            <dt>题库</dt>
            <dd>
              {pack.id}@{pack.version}（{pack.questions.length} 题，schemaVersion{' '}
              {pack.schemaVersion}）
            </dd>
          </div>
          <div>
            <dt>评分模型</dt>
            <dd>
              {scoring.id}@{scoring.version}
            </dd>
          </div>
          <div>
            <dt>角色模型</dt>
            <dd>
              {roleModel.id}@{roleModel.version}（{roleModel.roles.length} 类角色）
            </dd>
          </div>
          <div>
            <dt>A 层是否泄漏进角色权重</dt>
            <dd>
              {audit.layerAWeightViolations.length === 0
                ? '否（已静态校验）'
                : audit.layerAWeightViolations.join('、')}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h2>输出语言的禁用词（代码侧强制执行）</h2>
        <p className="hint">
          冻结的 role-model 文件里的 forbiddenLanguage
          列表较短，代码按并集强制执行，避免漏掉信任类与危险类标签。
        </p>
        <p className="forbidden-list">{REQUIRED_FORBIDDEN_LANGUAGE.join('、')}</p>
      </section>

      <section className="card">
        <h2>已知限制（本切片）</h2>
        <ul>
          <li>
            题库中 120 道题的难度全部相同、familyId
            全部唯一、没有反向题，因此抽题引擎的难度平衡、同族冲突过滤、反向题一致性三个阶段在本版题库下未激活。
          </li>
          <li>C 层每个维度只抽 1 题，归一化分数只能取极少数几个值，粒度过粗。</li>
          <li>
            全部 120
            道题都只有一个选项取到满分，表面效度上"只有一个明显好答案"，依赖选项打乱与跨题一致性缓解。
          </li>
          <li>答题进度、历史结果与 JSON 导出的持久化层尚未接入本切片。</li>
        </ul>
      </section>

      <div className="actions">
        <Link className="button primary" to="/assessment">
          开始测评
        </Link>
        <Link className="button" to="/">
          回首页
        </Link>
      </div>
    </main>
  )
}
