# CohortLens Question Bank Bundle V1.0

## Files

- `question-pack-v1.0.json` — 120道正式题库，可直接作为 Question Pack 导入。
- `scoring-model-v1.0.json` — 维度、归一化、置信度与一致性规则。
- `role-model-v1.0.json` — 六类协作角色的 V1 权重。
- `question-bank-v1.0.md` — 供人工审阅的无评分版题库。

## Composition

| Layer | Bank | Per assessment |
|---|---:|---:|
| 理论与问题理解 | 60 | 15 |
| 合作与行为 | 36 | 9 |
| 技能与角色 | 24 | 6 |
| Total | 120 | 30 |

### A层
四个宏观维度各15题：
1. `conceptual_understanding`
2. `theory_reality`
3. `organizational_judgment`
4. `reflexive_judgment`

单次抽取：4 + 4 + 4 + 3，具体哪一维少1题由 seeded sampler 按轮换/平衡规则决定，不能永久固定同一维少抽。

### B层
六维，每维6题：
- responsibility
- communication
- conflict_handling
- initiative
- reliability
- reflection

单次抽9题：六维至少各1题，剩余3题平衡随机。

### C层
六维，每维4题：
- research_skill
- execution_skill
- coordination_skill
- organization_skill
- technical_skill
- communication_skill

单次抽6题：每维恰好1题。

## Important implementation rules

1. **No total score.** 输出 profile vector。
2. **A层不得进入角色适配权重。**
3. **A层不得解释为政治立场、政治忠诚、政治可靠性或意识形态纯度。**
4. **B/C层属于自陈材料。** 不输出“撒谎概率”等伪精确结论。
5. `consistencyGroups` 只用于降低 confidence 或提示“需要进一步了解”。
6. AI 只读取结构化结果生成自然语言报告，不重算分数。
7. Question Pack / scoring / role model 必须各自保留版本号。

## Scoring

每题内部使用 0–3 信号。维度归一化：

`normalized = round(sum(score) / max_possible_for_answered_items * 100)`

不要与人口常模或百分位混淆。

建议结果只显示：
- 当前材料较弱 / 需更多信息
- 中等表现
- 较明显表现
- 当前问卷中表现突出

并同时显示 evidenceQuestionIds。

## Anti-gaming note

V1 采用可解释性优先设计，部分题目存在较明显的社会赞许答案。因此：
- 不设置“及格答案”或单一录取阈值；
- 使用120→30随机抽题；
- 使用跨题一致性；
- 保留原始回答供人工复核；
- 后续应根据真实使用反馈迭代 distractor 与 forced-choice 题。

如果公开部署到 GitHub Pages，前端题库和评分代码无法真正保密。压缩/混淆不等于安全。若未来需要隐藏评分规则，应改变部署架构，而不是依赖前端保密。

## Validation checklist for DSH

- exactly 120 questions
- IDs unique
- 60/36/24 layer split
- A macro dimensions 15 each
- B dimensions 6 each
- C dimensions 4 each
- all questions have exactly 4 options
- every option has scoring
- skill options may additionally have roleSignals
- sampler can always satisfy 15/9/6 quotas
- role fit ignores A layer
- no total score
