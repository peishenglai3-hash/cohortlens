# ADR-003 — LLM 不是评分引擎

状态：Accepted（V0.1）
日期：2026-10-07

## 背景

一个自然的诱惑是让模型读原始回答并直接给分或给结论。这会同时破坏可复现性（§4 Deterministic Core）、可解释性（§59 Evidence）与产品边界（§3 禁止秘密推断敏感属性）。

## 决策

LLM 永远位于最后一层。链路是：

```
Local Engine → Structured Result JSON → Sanitization → Report Payload → LLM → Narrative Report
```

LLM 只做"把结构化结果转写成自然语言"，不重算分数、不改维度、不新增证据。

## 后果

- 第一阶段评分不调用任何模型（§14）。`scoreAssessment` 是同步纯函数。
- 关闭 API 也能完成整个测评（§4 LLM Optional）。AI 报告失败不影响基础结果（§62）。
- 结果对象里每个维度都带 `evidenceQuestionIds`，这是"这句话从哪来"的可追溯基础（§59）。
- Prompt 独立存放于 `content/prompts/report/`，并版本化（§23）。不得散落在 React 组件里。
- 报告输出禁用词在代码侧按并集强制执行，而不只依赖冻结的 `role-model` 列表（见 ADR-007）。
- 待验证：LLM 报告链路（Prompt、Payload 最小化、失败降级 UI）不在本切片内，属于后续工作。
