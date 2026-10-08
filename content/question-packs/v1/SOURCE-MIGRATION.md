# DSH Migration Pack — Layer A V1.0 → V1.1

本补丁只修改 A 层测量模型。B层、C层与 role-model-v1.0 保持冻结。

## 1. 替换内容
将旧 Question Pack 中 60 道 `layer=theory_value` 题替换为 `a-question-pack-v1.1.json` / `question-pack-v1.1.json` 中的新 A 层。

单次 A 层配额改为：

- A0_declared_identity = 2
- A1_theory_structure = 3
- A2_political_economy = 3
- A3_social_political = 3
- A4_practice_orientation = 2
- A5_reflexivity = 2

合计仍为 15；整卷仍为 15 + 9 + 6 = 30。

## 2. Schema V1.1
A层新增/显式使用：
- `scoringMode`
- option `selfReportCategory`
- option `profileSignals`
- question metadata `optionOrderPolicy`

A0：categorical self-report，不参与数值总分。
A1：knowledge_accuracy，可生成“理论熟悉度”，但单次仅3题，必须标低精度。
A2/A3：默认展示 issue-position cards。
A4：默认展示 practice-pattern cards。
A5：只在两个抽中题目方向相对一致时给低置信度摘要，否则显示“混合/信息不足”。

## 3. 必须删除旧 A 一致性组
scoring-v1.0 中 CG05–CG08 引用了旧 A 题语义。V1.1 后这些映射失效。
V1.1 只保留 B-B 一致性组 CG01–CG04，除非后续经过人工设计再加入新的 A consistency group。

禁止因为 A001 等 ID 复用而沿用旧语义映射。

## 4. 历史数据迁移
历史 Session 必须由 `questionPackVersion` 解释。

开发期若已有 V1.0 测试 Session，可：
- 明确标记为 legacy 并绑定 v1.0 pack；或
- 仅在尚未交付甲方前清理开发测试 Session。

绝不能用 V1.1 当前题库按 ID 回填 V1.0 历史题目文本。

## 5. 结果页重构
A层不再显示旧四维：
- conceptual_understanding
- theory_reality
- organizational_judgment
- reflexive_judgment

改为六张分区卡：

1. 自我声明的理论认同（A0）
2. 理论熟悉程度（A1）
3. 政治经济议题立场（A2，原题+选择为主）
4. 社会—政治议题立场（A3，原题+选择为主）
5. 实践取向（A4，原题+选择为主）
6. 反身性（A5，谨慎摘要+证据）

不得出现：
- 政治可靠性
- 左翼纯度
- “真正马克思主义者”分
- 忠诚度
- 自动吸纳/淘汰
- A层综合总分

## 6. Option Order
A1 可随机打乱选项；其正确答案在题库中已人工平衡为 A/B/C/D 各3题。
A2/A3 是带有语义顺序的选项，禁止任意 shuffle；如需要顺序控制，只允许整体正序/反序。
A0 固定顺序。
A4/A5 可按题目 metadata 执行。

## 7. 角色适配
role-fit 继续只使用 B+C。
A层不得进入 role-fit。

## 8. LLM 报告
LLM 可以：
- 转述 A0 的自我声明；
- 总结 A1 熟悉度；
- 对 A2–A4 的原始选择做非裁决性总结；
- 对 A5 给谨慎描述。

LLM 不得：
- 从 A2–A5 推断 A0；
- 判定“真左/假左”；
- 给出政治可靠性或吸纳建议。

## 9. 本地 Gate
本轮继续只跑 local gate，不要求 GitHub Runner / Pages。
新增测试：
- 每次 A 层严格 2/3/3/3/2/2；
- A0 不进入 numeric total；
- A层不进入 role-fit；
- CG05–CG08 不再存在；
- A1 正确答案位置分布为 3/3/3/3；
- A2/A3 option order policy 不被普通 shuffle 破坏；
- V1.0/V1.1 session 不串 pack 版本。

完成后冻结为内容/测量补丁，不要顺手改 B/C。
