# ADR-005 — 题库版本化与 Schema 超集

状态：Accepted（V0.1）
日期：2026-10-07

## 背景

冻结的 `question-pack-v1.0.json` 与《工程圣经》第 7/8 节的 TypeScript 形状有三处不一致：

1. 题库顶层带 `assessmentPolicy.subQuota`、`assessmentPolicy.sampling`、`measurementNotice`，圣经的 `QuestionPack` 类型里没有这三个字段。
2. 圣经的 `scenarioType` 有 5 个取值，题库实际只用了 3 个（`concept` / `scenario` / `skill`）；B 层的 `scenarioType` 是 `scenario` 而不是 `self_report`。
3. A 层 60 题的 `subDimension` 两两不同（60 个唯一值），因此圣经 §11"核心 subDimension 至少覆盖一次"在 A 层只能退化为"四个宏观维度各 4/4/4/3"。

## 决策

1. **采用超集 Schema**：`assessmentPolicy` 保留 `subQuota` 与 `sampling`，`scenarioType` 保留 5 个取值但不要求每个都出现，`measurementNotice` 作为可选字段保留。理由是这三个字段承载的正是"5:3:2 是信息预算而不是加权总分"这条核心原则，丢掉它们等于把原则从数据里删掉。
2. **题库按版本独立命名**：`questionPackId` + `questionPackVersion` + `schemaVersion` 三段都进入会话与结果（§12/§45）。结果里保存 `cohortlens-cn-v1@1.0.0` 这样的完整引用。
3. **历史不可漂移**：会话保存 `questionIds`，评分时若某个 id 在题库里找不到，抛错而不是跳过（`ScoringError`，见 `src/engine/scoring.ts`）。同理，`scoringVersion` 与 `questionPackVersion` 不匹配时拒绝重算。
4. **A 层覆盖规则改写**：以"四个宏观维度各 4/4/4/3，少抽 1 题的那个维度随 seed 轮换"实现（源 README 第 26 行"不能永久固定同一维少抽"）。`sampleQuestionSet` 接受 `previousSessions`，可显式避免与上一次重复。

## 后果

- Schema 校验在启动时执行（Zod），题库写错会在打开应用时立刻失败，而不是算出静默错误的分数。
- `npm run validate:questions` 覆盖 34 项检查，其中 4 项在本版题库下如实报告为"未激活"。
- 代价：圣经第 8 节的类型定义不再是题库的精确形状，而是它的子集。任何 fork 若改用圣经原版 schema，需要删掉 `subQuota` 并重新定义 A 层覆盖规则。
