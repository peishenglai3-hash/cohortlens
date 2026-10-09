import { z } from 'zod'
import { assessmentResultSchema, assessmentSessionSchema } from './schemas.ts'

/**
 * 提交契约（Review Console submission contract）—— 把一份本地测评结果交给甲方审阅台。
 *
 * 这个模块定义的是**跨信任边界**的数据形状：本机浏览器 → 甲方（或本项目）的 Worker → D1。
 * 因此它和本地那套"随便存"的 schema 有三点关键差别：
 *
 *   1. **提交物必须自带版本三元组。** 审阅台可能在几周后才打开一份旧提交，那时本地题库早已换代。
 *      没有版本号的提交记录是无法解读的：`normalizedScore` 只在产生它的那套题库里有意义。
 *   2. **不含任何凭据。** 载荷由 `buildExportBundle`（ADR-014 白名单）派生，再剥掉会话内部字段，
 *      所以 API Key 结构上不可能进入提交物。
 *   3. **不包含任何"是否通过"的字段。** 见下方 `REVIEW_DECISION_LABELS`。
 */

/** 提交格式版本。与导出格式版本独立演进：审阅台关心的是"能不能读"，导出关心的是"文件长什么样"。 */
export const SUBMISSION_FORMAT = 'cohortlens-submission'
export const SUBMISSION_FORMAT_VERSION = '1.0'

/**
 * 提交时作答者需要提供的最小身份信息。
 *
 * 当前只有一项联系方式，这是甲方明确要求且**仅此一项**的字段（决策记录：作答者身份信息 =
 * 联系方式）。学号、姓名、院系一律不收集；编号由后端生成，作答者不填也不可见。
 *
 * 联系方式是可选填写但提交时必须非空（`contactValue` 为必填）——如果哪天要改成匿名候选池，
 * 改动点是这里加一个 `kind: 'anonymous'`，而不是把字段做成可选了事：可选字段会在界面上变成
 * "要不要填呢"，而这是个需要明确决定的设计问题。
 */
export const CONTACT_KINDS = ['email', 'phone'] as const
export const contactKindSchema = z.enum(CONTACT_KINDS)
export type ContactKind = z.infer<typeof contactKindSchema>

export const contactSchema = z
  .object({
    kind: contactKindSchema,
    value: z.string().trim().min(3).max(120),
  })
  .strict()

export type Contact = z.infer<typeof contactSchema>

/**
 * 审阅台允许出现的**人工**结论标签。
 *
 * 这里没有"通过/不通过"：产品边界明令不输出录用或淘汰建议（`RESULT_BOUNDARY_NOTICE`、
 * A 层 `useForAdmissionDecision: false`）。审阅台记录的是**审阅人自己的判断状态**——
 * 它是一份工作记录，不是系统给出的判决。`reason` 必填也是刻意的：一个只有状态没有理由的
 * 记录，几周后连审阅人自己都看不懂当时为什么这么判。
 */
export const REVIEW_DECISION_LABELS = [
  'undecided',
  'shortlisted',
  'needs_more_info',
  'not_this_round',
] as const

export const reviewDecisionLabelSchema = z.enum(REVIEW_DECISION_LABELS)
export type ReviewDecisionLabel = z.infer<typeof reviewDecisionLabelSchema>

export const reviewDecisionSchema = z
  .object({
    label: reviewDecisionLabelSchema,
    reason: z.string().trim().max(2000).default(''),
    /** ISO 时间戳。审阅台写入，服务端不接受客户端指定的时间。 */
    decidedAt: z.string().min(1).optional(),
  })
  .strict()

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>

/** 提交物的内容主体：版本三元组 + 会话 + 结构化结果。 */
export const submissionCoreSchema = z
  .object({
    formatVersion: z.string().min(1),
    submittedAt: z.string().min(1),
    /** 作答发生的时刻，来自会话本身，便于区分"作答时间"与"提交时间"。 */
    assessedAt: z.string().min(1),
    versions: z
      .object({
        questionPackId: z.string().min(1),
        questionPackVersion: z.string().min(1),
        scoringVersion: z.string().min(1),
        roleModelVersion: z.string().min(1),
      })
      .strict(),
    session: assessmentSessionSchema,
    result: assessmentResultSchema,
  })
  .strict()

export type SubmissionCore = z.infer<typeof submissionCoreSchema>

/**
 * 完整的提交请求体。
 *
 * `clientSubmissionId` 是**幂等键**：作答者的网络在提交那一刻断掉时，客户端会重试，
 * 而没有幂等键的重试会产生两条记录——审阅台里就会出现两份一模一样的作答，而人很难判断
 * 那到底是两个人还是一次网络抖动。
 */
export const submissionRequestSchema = z
  .object({
    format: z.literal(SUBMISSION_FORMAT),
    clientSubmissionId: z.string().uuid(),
    inviteCode: z.string().trim().min(1).max(120),
    contact: contactSchema,
    core: submissionCoreSchema,
    /** 作答者在提交页勾选的同意项。服务端会校验为 true，否则拒绝。 */
    consent: z.literal(true),
  })
  .strict()

export type SubmissionRequest = z.infer<typeof submissionRequestSchema>

// ---------------------------------------------------------------------------
// 审阅摘要（服务端派生）
// ---------------------------------------------------------------------------

/**
 * 材料充分度：**机械的**完成度度量，不是评分。
 *
 * 它只回答"这份提交有多少被实际作答、有哪些维度没拿到预期的证据量"，不回答"这个人好不好"。
 * 命名为 `material`（材料）而不是 `quality`（质量）或 `score`（分数）就是为了让这个区别在
 * 类型层面就显出来：审阅台可以按它排序，但不能把它当成结论。
 */
export const materialSufficiencySchema = z
  .object({
    answeredItems: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
    completionRatio: z.number().min(0).max(1),
    /**
     * 没拿到预期证据量的维度（`answeredItems < expectedItems`）。
     *
     * 第一版这里是"作答数 <= 2 的维度"，在真实数据上**几乎每个 B/C 维度都会命中**——因为这一层
     * 每维本来就只抽 1-2 题。一个永远在报的告警等于没有告警，而它还会把真正的问题（某一维完全
     * 没答）淹掉。改成与**该维预期题量**比较之后，它只在"这份提交在该维上缺材料"时才出现。
     */
    thinDimensions: z.array(z.string()),
    /** 每维的实际/预期题量，供审阅人自己核对，而不是只看到一个结论。 */
    coverage: z.array(
      z
        .object({
          dimension: z.string(),
          answeredItems: z.number().int().nonnegative(),
          expectedItems: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    /** 一致性引擎要求"需要进一步了解"的配对。 */
    needsFurtherUnderstanding: z.boolean(),
  })
  .strict()

export type MaterialSufficiency = z.infer<typeof materialSufficiencySchema>

/**
 * 审阅摘要 —— 审阅台列表页与详情页都读它。
 *
 * 它**不包含**任何 `recommendation` / `verdict` / `pass` / `score` 字段，这不是遗漏：
 * 加一个这样的字段就等于把产品边界里的"不输出录用或淘汰建议"挪到了后端。测试
 * `tests/unit/submission-contract.test.ts` 会遍历序列化结果断言这些字段不存在，
 * 所以将来有人想加也会先撞到测试。
 */
export const reviewSummarySchema = z
  .object({
    submissionId: z.string().min(1),
    receivedAt: z.string().min(1),
    assessedAt: z.string().min(1),
    inviteLabel: z.string(),
    contact: contactSchema.nullable(),
    versions: submissionCoreSchema.shape.versions,
    material: materialSufficiencySchema,
    /** A/B/C 三层的维度画像。A 层维度在此只作为"有哪些部分"出现，不带可比较分数。 */
    dimensions: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          layer: z.enum(['theory_value', 'cooperation_behavior', 'skill_role']),
          scoringKind: z.enum(['numeric', 'knowledge', 'categorical', 'descriptive']),
          normalizedScore: z.number().min(0).max(100),
          band: z.string(),
          answeredItems: z.number().int().nonnegative(),
          confidence: z.number().min(0).max(1),
        })
        .strict(),
    ),
    /** 角色适配原始结果，供审阅人自己读权重覆盖率与参与维度。 */
    roleFits: z.array(
      z
        .object({
          roleId: z.string(),
          name: z.string(),
          fitScore: z.number().min(0).max(100),
          coverage: z.number().min(0).max(1),
          contributingDimensions: z.array(z.string()),
        })
        .strict(),
    ),
    /**
     * A 层六部分的**可读呈现**。审阅人需要读到它（这是甲方要的"政治—理论画像"），
     * 但它被刻意放在独立字段里，且不带任何汇总数字——六部分不可合计。
     */
    aLayer: z
      .object({
        declaredIdentity: z.array(
          z
            .object({ topic: z.string(), selectedCategory: z.string(), selectedText: z.string() })
            .strict(),
        ),
        theoryFamiliarity: z
          .object({ correct: z.number(), answered: z.number(), lowSample: z.boolean() })
          .strict()
          .nullable(),
        issuePositions: z.array(
          z.object({ dimension: z.string(), topic: z.string(), selectedText: z.string() }).strict(),
        ),
        reflexivity: z
          .object({
            state: z.enum(['aligned', 'mixed', 'insufficient']),
            confidence: z.number(),
          })
          .strict(),
        boundaries: z.array(z.string()),
      })
      .strict()
      .nullable(),
    limitations: z.array(z.string()),
    decision: reviewDecisionSchema.nullable(),
  })
  .strict()

export type ReviewSummary = z.infer<typeof reviewSummarySchema>

/** 客户端在提交前需要看到的说明。由服务端下发，避免客户端与服务端各写一份而漂移。 */
export const submissionNoticeSchema = z
  .object({
    title: z.string(),
    points: z.array(z.string()),
    retainedFor: z.string(),
    withdrawal: z.string(),
  })
  .strict()

export type SubmissionNotice = z.infer<typeof submissionNoticeSchema>

export const SUBMISSION_NOTICE: SubmissionNotice = {
  title: '提交前请确认',
  points: [
    '你即将把这次测评的作答与结果上传给发起这次测评的人。',
    '上传内容包括：全部作答（选项 id 与题目 id）、结构化结果、你填写的联系方式。',
    '不会上传：任何 API Key、你的浏览器信息、你的历史记录、其他测评的内容。',
    '上传后发起方可以长期查看这份材料，用于人工了解与筛选。',
    '你可以随时要求发起方删除你的材料；联系方式就在你填写的那个渠道。',
  ],
  retainedFor: '由发起方在其审阅台中保存，本工具不设自动过期时间。',
  withdrawal: '如需撤回，请直接联系发起方；你本机的副本可以用历史页的删除功能清掉。',
}
