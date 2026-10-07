# ADR-008 — `confidence.base` 里 `expected_items` 的定义

状态：Accepted（V0.1）
日期：2026-10-07

## 背景

圣经 §14 与源 README 都写 `confidence.base = answered_items / expected_items`，但都没有定义 `expected_items`。这个值决定了置信度的量纲，不能靠实现者各写各的。

B 层与 C 层的抽题结构本身就意味着"期望题量"因维度而异：C 层每维恰好 1 题，B 层每维至少 1 题而总数 9 题摊到 6 维。

## 决策

按以下优先级取值（`buildExpectedItems`，`src/engine/scoring.ts`）：

1. 题库声明的单次每维配额（A 层 `subQuota.theory_value`）；
2. 题库声明的"每维恰好若干题"（C 层 `subQuota.skill_role.exactlyPerDimension`）；
3. 题库声明的"每维至少若干题"（B 层 `subQuota.cooperation_behavior.minimumPerDimension`）；
4. 都没有时，用该层配额除以该层维度数。

不把 A 层那个"少抽 1 题"的轮换结果写进期望值：期望值是**设计意图**，不是本次抽样的实际结果。否则同一维度在不同 seed 下置信度会无理由跳动。

## 后果

- 在本版题库下：A 层三维期望 4 题、轮换维度期望 4 题；B 层每维期望 1 题；C 层每维期望 1 题。
- B / C 层因此合理地在置信度上偏低。这正是真实情况：**12 个维度每次只由 1-2 道题支撑**，必须在 UI 上写清楚（`DimensionResult.warnings`）。
- C 层维度归一化后只有 2-3 个可能取值（例如 `0 / 33 / 100`，抽到"最低档也计 1 分"的题时只有 `33 / 100`）。13 道题的最低选项分值大于 0，抽到它们时该维度的 0 分档不可达。系统如实报告可达取值集合，不假装是细粒度测量。
- 代价：置信度是"覆盖度 × 一致性惩罚"，不是统计意义上的置信区间。它只回答"这次问卷有没有足够材料谈这个维度"，不能解释为测量精度。
