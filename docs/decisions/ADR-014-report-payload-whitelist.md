# ADR-014 — 报告链路的载荷是白名单构造，模型输出过边界过滤器

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

链路必须严格保持（brief §18）：

```
Answers → Local Engine → Structured Result → Sanitized Report Payload → AI Provider → Narrative Report
```

两个失效模式需要同时防住：

1. **载荷泄漏**：把整个 Structured Result 丢给模型，于是答题者的作答原文、会话 id、原始选项一并出网（违反 §60 最小化）。
2. **输出越界**：模型无视指令，输出"值得信任""危险人物""录用建议"。

## 决策

**输入侧**：`buildReportPayload` 用**显式白名单**构造，而不是从结果里删字段。每条字段都要被写下来才会进入载荷，因此未来 schema 新增字段不会自动开始出网。

进入载荷的只有：维度（id/名称/层/分数/区间/题量/置信度/证据 question id）、角色适配（id/名称/分数/覆盖率）、引擎已经写好的 strengths / developmentAreas / consistency / limitations，以及一段明确的 `boundaries` 指令。
**不进入**：作答原文、所选选项 id、session id、result id、任何身份字段、任何 Key。

**输出侧**：模型返回的文本在显示与落盘之前先过 `maskForbiddenLanguage`（`domain/boundaries.ts`，与 role-fit 共用同一份清单）。命中即替换为 `[已按产品边界屏蔽]`，并把命中的词记进 `ReportRecord.sanitizedViolations`，在报告顶部告知用户"有 N 处用语触碰了产品边界，已被自动屏蔽"。

**渲染侧**：报告用自写的小型 Markdown 渲染器渲染为 React 文本节点，全流程没有 `dangerouslySetInnerHTML`，因此模型输出无法注入标记。

## 后果

- 一个完全无视指令的模型也**不能**把禁用标签放到用户眼前。已由测试固定：喂给服务层一段满是"不值得信任/危险人物/撒谎概率/政治可靠"的报告，断言显示文本里一个都不剩，且 `sanitizedViolations` 记录了 4 项以上。
- 提示词版本化（`REPORT_PROMPT_VERSION = report-prompt-v1`），落盘时记录，`reportPromptIsCurrent()` 可判断旧报告是否过期。
- 代价：白名单需要维护。新增一个希望进入报告的字段时，必须显式改 `report-payload.ts`——这是刻意设置的摩擦。
