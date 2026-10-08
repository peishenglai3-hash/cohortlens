# A 层题库更换说明（V1.0 → V1.1）

日期：2026-10-08
触发：甲方反馈与决策层纠偏，决定更换 A 类题库素材
来源目录：`C:\Users\35636\Downloads\cohortlens_a_question_pack_v1_1`（**只读，未改动**）
回滚点：`D:\外包01\_backup\cohortlens-local-mvp-v0.1-20261008-185515.zip`（114 项，已校验可读）

---

## 1. 换了什么

| | V1.0 | V1.1 |
| --- | --- | --- |
| 题库 id / 版本 | `cohortlens-cn-v1@1.0.0` | `cohortlens-question-pack-v1.1@1.1.0` |
| 评分模型 | `scoring-v1@1.0.0` | `scoring-v1.1@1.1.0` |
| A 层维度 | 4 个 | **6 个**（A0–A5） |
| A 层单次配额 | 4 / 4 / 4 / 3（短维轮转） | **2 / 3 / 3 / 3 / 2 / 2（固定）** |
| A 层题目 | 60 | 60（全部替换，仅 8 个 id 复用） |
| B / C 层 | 60 题 | **完全相同**（逐题比对，零差异） |
| 一致性组 | CG01–CG08 | **CG01–CG04**（CG05–CG08 全部引用 A 层，删除） |
| 报告 Prompt | `report-prompt-v1` | `report-prompt-v2` |

**A 层六维分工**

| 维度 | 题量 | 配额 | 测什么 | 呈现形态 |
| --- | --- | --- | --- | --- |
| `A0_declared_identity` | 8 | 2 | 自我声明的理论认同（受控类别） | 原样引用，**无分数** |
| `A1_theory_structure` | 12 | 3 | 概念题的正确答案 | 0–100 + 低精度提示 |
| `A2_political_economy` | 12 | 3 | 政治经济议题立场 | 证据卡，**不折算** |
| `A3_social_political` | 12 | 3 | 社会—政治议题立场 | 证据卡，**不折算** |
| `A4_practice_orientation` | 8 | 2 | 实践取向 | 证据卡，**不折算** |
| `A5_reflexivity` | 8 | 2 | 反身性与修正方式 | 状态 + 谨慎摘要 |

---

## 2. 逐字节校验（安装时已完成）

六个源文件与项目内副本 SHA-256 完全一致：

| 文件 | SHA-256（前 16 位） |
| --- | --- |
| `question-pack-v1.1.json` | `DA37A9090991983A` |
| `scoring-model-v1.1.json` | `6A6F1F7C0ACB2ED2` |
| `a-scoring-model-v1.1.json` | `E523441CEA46822C` |
| `a-result-schema-v1.1.json` | `F056E3DBD035650F` |
| `role-model-v1.0.json` | `1386C1CE2E452CEB`（与 V1.0 冻结副本逐字节相同） |
| `a-question-bank-v1.1.md` | `D4D79E574C855079` |

V1.0 的两个内容文件**没有删除**，移到 `content/**/_legacy-v1.0/`，并且**不再被 `load-content.ts` import**：
所以它们不进构建产物，也不可能被误选。

> 来源目录里还有一份 `a-question-pack-v1.1.json`（作者的草稿版）。它的 60 道题干与正式包**逐字相同**，但
> 选项 id 是 `"A".."D"`、字段名是 `category`、没有 `profileSignals`、没有题目级 metadata、`version: 1`。
> 正式包 `question-pack-v1.1.json` 是唯一权威版本，草稿版未被采用。

---

## 3. 代码侧的改动

### 3.1 数据模型（`src/domain/schemas.ts`）

新增（全部可选，V1.0 数据仍然合法）：

- `questionOptionSchema.selfReportCategory`：A0 的自报类别。
- `questionOptionSchema.profileSignals`：`axisId → −2…2` 的探索性轴信号。
- `questionSchema.scoringMode`：`knowledge_accuracy` | `profile_signal`。
- `metadata.optionOrderPolicy`：`fixed` | `shuffle` | `preserve_or_reverse`。
- `assessmentPolicy.sampling.optionShuffle`：由 `boolean` 放宽为 `boolean | string`（V1.1 写 `"per_question_policy"`）。
- `measurementNotice`：由对象放宽为 `对象 | 字符串数组`（V1.1 用数组）。
- `dimensionResultSchema.scoringKind` / `scoredItems`。
- `assessmentResultSchema.aLayerProfile`（A 层六部分；V1.0 结果无此字段）。
- `scoringModelSchema.layerA.aggregateTotalScore` / `displayPolicy`、`layerAProfilePolicy`。
- 新增 `aScoringModelSchema`、`aResultSchemaDocSchema`，装载 `a-scoring-model-v1.1.json` 与 `a-result-schema-v1.1.json`。

### 3.2 抽样器（`src/engine/sampler.ts`）

- A 层计划改为**直接读 `subQuota.theory_value`**，删除轮转短维度机制；配额之和不等于层级配额即抛错。
- `avoidSameFamily` 改为**同一维度内每族只取一次**。
- 难度均衡改为**同维度内交换**，题量与维度分布构造上不变（修掉两个真实缺陷，见 ADR-018）。
- 新增**每维配额断言**：抽完逐维核对，不足即抛错。
- `resolveOptionOrder()` 新增，按题目级 `optionOrderPolicy` 决定选项顺序；`preserve_or_reverse` 只允许
  原序或整体反转，由种子决定方向。

### 3.3 评分（`src/engine/scoring.ts`、`src/engine/a-layer-profile.ts`）

- `scoring` 为空的选项**不产生数值信号**（而不是按 0 计）。
- 新增 `scoringKindFor()`，逐题判定 `numeric` / `knowledge` / `categorical` / `descriptive`。
- 无分维度：`band` = "不产生分数"，界面不渲染进度条，导出文本写"N 题不计分"。
- 新增 `buildALayerProfile()`：A0 原样引用、A1 答对数、A2–A4 证据卡、A5 状态判定。
- "主要优势 / 需要更多信息的方向"只从**有分**的维度里选；A1 用 knowledge 专用措辞。

### 3.4 界面与导出

- `src/pages/Result/ALayerSection.tsx`：A 层六张分区卡。
- `ResultPage.tsx`：A 层走新组件，B/C 走原有维度行；无分维度显示"不产生分数"徽标。
- `src/domain/report-text.ts`：打印/PDF 纯文本同步重构为六个叙事小节。

### 3.5 AI 报告

- `report-prompt-v1` → **`report-prompt-v2`**：新增 `## A 层画像的呈现方式` 一节；A0/A1/A2–A4/A5 各一条规则；
  新增"六部分不得相加"与"A 层不得用于角色适配/吸纳/淘汰"。
- 载荷新增 `aLayer`（仍走白名单）：A0 只带受控类别名；A2–A4 只带题量与主题标签，
  **不含选项原文**（选项原文属于答卷内容，按 §60 不进载荷）。
- 载荷的 `dimensions[]` 增加 `scoringKind` / `scoredItems`，避免模型把"不产生分数"读成"得分很低"。

### 3.6 校验器（`src/domain/validation.ts`）

新增 6 项 A 层结构检查：

| 检查 | 作用 |
| --- | --- |
| `a_layer_quota_shape` | 六维配额形状正确、每维题量够用、合计等于层级配额 |
| `a0_self_report_only` | A0 全部 `self_report`、全部有唯一 `selfReportCategory`、全部不参与计分 |
| `a1_answer_position_balance` | A1 正确答案位置分布（实测 A/B/C/D 各 3） |
| `option_order_policy_respected` | 题目级顺序策略合法，且不被题库级 `optionShuffle=true` 打乱 |
| `stale_a_consistency_groups_removed` | 一致性组不得引用任何 A 层题目（防止只把 id 改成新题而语义仍旧） |
| `a_layer_scoring_policy_consistency` | A 层呈现政策自洽：六维都有 `displayPolicy`、探索性信号不面向用户、不进 role-fit、不生成总分 |
| `a_layer_boundary_text` | A 层 60 题的题干与选项不得出现任何禁用输出语（实测 0 命中） |

同时放宽/修正：`illegal_scoring_key` 接受测量键 `theory_familiarity`；`option_missing_scoring` 接受
描述性题目的空 `scoring`；`degenerate_score_spread`、`key_position_tell` 只对计分题生效；
`family_conflict` 改用"每维族数 ≥ 该维配额"。

---

## 4. 验证结果

| 项目 | 结果 |
| --- | --- |
| `npm run gate:local` | **exit 0** |
| 单元/集成测试 | **204 通过**（V1.0 为 162；新增 42，含 `tests/unit/a-layer-v11.test.ts` 40 条） |
| 覆盖率（`src/engine` + `src/domain`） | 引擎 **94.72%** 行、domain **90.72%** 行（阈值 90%） |
| `validate:questions` | 无错误；4 条 Warning + 2 项 inactive，全部如实报出 |
| `validate:config` | 无错误；15 个内容文件无密钥材料；产物无裸绝对路径 |
| Playwright 桌面 E2E | **24 通过**（新增 2 条 A 层专项） |
| Playwright 移动 E2E | **24 通过**（与桌面同集，Chromium 移动 viewport） |

### 迁移文档要求的 7 条新测试

| 要求 | 落地位置 | 状态 |
| --- | --- | --- |
| A 层严格 2/3/3/3/2/2 | `a-layer-v11.test.ts` rule 1（400 次抽样） | ✅ |
| A0 不进数值总分 | rule 2（40 次抽样逐条核对字段） | ✅ |
| A 层不进 role-fit | rule 3（含"改掉全部 A 层作答，role-fit 逐字节不变"） | ✅ |
| CG05–CG08 已不存在 | rule 4（含两条反向篡改测试） | ✅ |
| A1 正确答案位置 3/3/3/3 | rule 5 | ✅ |
| A2/A3 选项顺序不被普通打乱破坏 | rule 6（含"两个方向都出现过"） | ✅ |
| V1.0 / V1.1 会话不得跨版本评分 | rule 7 | ✅ |

---

## 5. 已知代价（如实标注）

1. **V1.0 历史会话无法用当前构建重算。** 版本守卫会明确拒绝并打印两个版本号。
   历史记录本身仍可打开、查看当时的作答、当时的分数快照与证据题号。
2. **即使 B/C 题目逐字节相同，V1.0 会话的 B/C 分数也无法逐位复现。** V1.0 的 `CG05`–`CG08` 含跨 A/B
   的一致性组，会下调相关 B 维度置信度；这些组在 V1.1 已删除。任何"用 V1.1 重算 V1.0 会话以做对比"
   的做法都会得到不一致的数字，**不要这样做**。
3. **8 个 A 层 id 被复用**（`A001`–`A008`），含义完全不同。任何按 id 跨版本比对 A 层内容的脚本都会
   得到错误结论。一致性组检查正是为堵这个口子而加。
4. **A 层 60 题中 48 题不计分**，因此 A 层的"分数"只剩 A1 一项，且只有 3 题。这是 V1.1 的设计取向
   （描述性证据优先），不是缺陷；系统在界面、导出、打印、AI 载荷四处都写明。
5. **A1 的 3 题是知识题**，答对/答错会直接影响一个 0–100 数字。产品措辞已按"低精度提示"处理，但
   使用者仍可能过度解读——这一条属于人工验收范围。
6. **V1.0 题库保留但不打包。** 若将来需要"查看 V1.0 原题"，必须改 `load-content.ts` 的 import，
   不能靠运行时切换。
