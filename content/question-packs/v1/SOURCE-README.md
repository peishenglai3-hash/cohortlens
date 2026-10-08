# CohortLens — A Question Pack V1.1

本包用于替换 V1.0 的 A 层。B/C 与 role model 不变。

## 设计目标
把 A 层从“理论能力考试”重构为六维政治—理论 Profile：

- A0 自我认同：直接、自愿、自报；
- A1 理论结构：概念与方法理解；
- A2 政治经济价值：具体议题立场；
- A3 社会—政治价值：参与、权利、组织、程序、多元；
- A4 实践取向：长期参与和具体任务模式；
- A5 反身性：证据修正、不确定性、理论—实践反馈。

## 关键方法论
V1.1 是 pilot instrument，不宣称已经具有心理计量学意义上的常模、稳定信效度或诊断能力。
A2/A3/A4 默认呈现“回答证据卡”，不把3题/2题稀疏样本伪装成高精度多轴测量。

## 文件
- `a-question-pack-v1.1.json`：A层独立题库（60题）
- `a-scoring-model-v1.1.json`：A层评分/呈现原则
- `a-result-schema-v1.1.json`：A层结果结构
- `a-question-bank-v1.1.md`：人工审题版
- `question-pack-v1.1.json`：完整120题包（A V1.1 + B/C V1.0）
- `scoring-model-v1.1.json`：完整评分配置
- `role-model-v1.0.json`：原样冻结
- `DSH-MIGRATION-V1.1.md`：给 DSH 的迁移说明

## 单次30题
A=15 / B=9 / C=6。

A内部：
2 / 3 / 3 / 3 / 2 / 2。

## 不允许
不生成政治可靠性、意识形态纯度、忠诚度、自动吸纳/淘汰、A层综合总分。
A0只能来自直接自报。
