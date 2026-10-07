# ADR-016 — 内容与工程解耦：本阶段不修题库

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

对题库 V1.0 的独立审计发现了真实的内容问题：选项位置偏差（满分项 76.7% 落在位置 B）、全部 120 题都只有一个"明显好答案"、11 道题题干缺谓语、7 道 A 层题措辞可被读成政治判断、`CG08` 备注带有个人层面的政治多元性推断。

与此同时，题库属于 Content Track，代码属于 Engineering Track。本阶段有一个明确的架构断言要验证：

> 未来提供 `question-pack-v1.1` 时，**无需改 Engine** 即可替换题库。

## 决策

**本阶段一字不改题库。** 保持三个内容文件 byte-for-byte unchanged：

```
question-pack-v1.0.json
scoring-model-v1.0.json
role-model-v1.0.json
```

所有已发现的内容问题进入 **Known Content Issues**，由校验器持续以 Warning 报出，不静默、不回退、不因为"看着不舒服"而删掉检查项。

同时严格区分两种结果：

```
Error   → Gate Fail（构建/校验失败，必须修）
Warning → Pass with Warning（如实报出，允许继续）
```

## 后果

- 工程阶段不会把内容问题和代码问题耦合在一起：一个题目的措辞问题不会阻塞一次 Provider 重构。
- 校验器每次运行都打印这 8 类内容警告，用户与开发者都能看见。"没报错"不等于"没问题"。
- `content/` 被排除在 Prettier 之外（`.prettierignore`），保证格式化永远不会静默改动冻结内容；每次交付前重新校验 SHA-256。
- 未来替换 v1.1 只需替换文件并重跑两个校验器；本次已经用测试证明：换一套 pack 后 `sampleQuestionSet`、`scoreAssessment`、`computeRoleFits` 都不需要任何修改（`tests/unit/sampler.test.ts` 里的 trimmed/fixture pack 走的就是另一套配额与维度）。
- 代价：Local MVP 会在已知有测量缺陷的题库上运行。这一点写在 README 与结果页的「测评局限性」里，不靠隐瞒维持"看起来可用"。
