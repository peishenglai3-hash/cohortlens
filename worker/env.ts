import type { ReviewDecisionLabel } from '../src/domain/submission.ts'

/**
 * D1 绑定。**结构化声明，而不是引用 Cloudflare 的全局类型。**
 *
 * 为什么不直接写 `D1Database`：那是 `@cloudflare/workers-types` 提供的全局类型，把它拉进主
 * `tsconfig` 程序会**静默覆盖浏览器全局**——`D1Database` 里有一个 `exec` 成员，和 DOM 里
 * （旧规范）的 `Database` 撞名，而 TypeScript 会采用后者，于是 `indexedDB` 在类型层面消失、
 * 变成 `IDBFactory`。这个后果看起来完全无关：整个项目的存储层报出一堆"找不到 indexedDB"。
 *
 * 声明成结构类型之后，Worker 只依赖"它调用的那几个方法存在"，主程序与 Worker 程序互不污染，
 * 而且测试替身只要实现这几个方法就能用，不需要模拟整个 Cloudflare 运行时。
 */
export interface D1Like {
  prepare(query: string): D1PreparedStatementLike
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1Result<T>[]>
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = unknown>(column?: string): Promise<T | null>
  run(): Promise<D1Result<unknown>>
  all<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Result<T> {
  success: boolean
  results?: T[]
  meta?: { changes?: number; rows_read?: number; rows_written?: number }
}

/**
 * 生产代码里写 `D1Like` 就够了：真实的 `D1Database` 在结构上满足它。
 * 保留别名是为了让 `Env` 的读起来仍然像是"一个 D1 数据库"，而不是"某个我们自造的接口"。
 */
export type D1Database = D1Like

/**
 * Worker 运行环境与绑定。
 *
 * `DB` / `ADMIN_TOKEN` 由 wrangler 的绑定与 secret 注入；`ALLOWED_ORIGINS` 与 `RESPONDENT_ORIGIN`
 * 是可选的普通变量。所有值都当**不可信输入**看待：wrangler.toml 是仓库里的文件，
 * 但部署时可能被 `--var` 覆盖，所以任何一个都可能为空或格式不对。
 */
export interface Env {
  /** D1 绑定。缺失即整个 Worker 无法工作，启动时就该失败得响亮。 */
  DB: D1Database
  /** 审阅台口令。必须是 secret（`wrangler secret put ADMIN_TOKEN`），不进 wrangler.toml。 */
  ADMIN_TOKEN: string
  /**
   * 允许的跨域来源，逗号分隔。作答端部署在 Cloudflare Pages 上，与 Worker 不同源，
   * 所以提交接口必须返回 CORS 头。
   *
   * 默认值不含 `*`：带上凭据的接口配 `*` 等于谁都能从任意站点提交。空值表示"只允许同源"，
   * 这会让跨域提交全部失败——一个安静的部署错误，因此 `missingAllowedOrigins()` 会把它报出来。
   */
  ALLOWED_ORIGINS?: string
  /** 可选的作答端地址，用于在 CORS 错误信息里给出提示。 */
  RESPONDENT_ORIGIN?: string
}

/** 审阅台写结论时的请求体。 */
export interface DecisionInput {
  label: ReviewDecisionLabel
  reason: string
}

/** 提交接口的成功响应。刻意不返回提交 id 之外的任何东西。 */
export interface SubmitResponse {
  ok: true
  /** 幂等键对应的提交 id。同一份材料重复提交会返回同一个 id。 */
  submissionId: string
  /** `created` = 这次真的写入了；`existing` = 之前已经提交过，本次是重复提交。 */
  status: 'created' | 'existing'
  receivedAt: string
}

export interface ApiError {
  ok: false
  code: string
  message: string
  /** 给人看的下一步建议。没有有用建议时为空字符串。 */
  hint: string
}
