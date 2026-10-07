/**
 * Product configuration — Engineering Bible §64.
 *
 * The final product name is NOT frozen (Engineering Bible header: "最终产品名称：未冻结"). It is
 * therefore a single value in this file and appears nowhere in business logic. Renaming the
 * product is a one-line change here, and the frozen question pack is never touched.
 */

export interface ProductConfig {
  name: string
  subtitle: string
  description: string
  logo?: string
  assessment: {
    questionPackId: string
    scoringModelId: string
    roleModelId: string
  }
}

export const PRODUCT_CONFIG: ProductConfig = {
  name: 'CohortLens',
  subtitle: '本地优先的结构化测评工具',
  description:
    '面向小型团队、兴趣共同体与协作组织的本地优先结构化测评工具。系统整理参与者已经主动表达的信息，不代替人做吸纳、排除或政治判断。',
  assessment: {
    questionPackId: 'cohortlens-cn-v1',
    scoringModelId: 'scoring-v1',
    roleModelId: 'roles-v1',
  },
}

/**
 * Privacy notice shown before an assessment starts (Engineering Bible §39).
 * Kept here so a fork can rewrite the wording without touching a component.
 */
export const PRIVACY_NOTICE = {
  title: '数据使用说明',
  points: [
    '你的回答默认只保存在这台设备的浏览器数据里，本项目没有自己的中央服务器。',
    '只有当你主动点击"生成 AI 报告"时，相关报告数据才会发送到你自己配置的模型服务。',
    '建议不要填写真实姓名、身份证号、联系方式等不必要的个人信息。',
    '题库与评分版本会随结果一起保存，历史结果不会因为题库升级而变化。',
  ],
} as const

/**
 * Boundary reminder shown on the result page (Engineering Bible §15, §17, §70).
 * This is a product constraint, not decoration: it is the sentence that keeps a structured
 * number from being read as a verdict about a person.
 */
export const RESULT_BOUNDARY_NOTICE = {
  title: '这份结果的边界',
  points: [
    '分数表示的是"在当前题库体系下，这些回答呈现出什么"，不是人格、道德或人的价值本身。',
    '理论层结果不得解释为政治立场、政治忠诚、政治可靠性或意识形态纯度。',
    '系统不输出单一总分，也不输出录用或淘汰建议。最终判断由人结合原始回答作出。',
  ],
} as const
