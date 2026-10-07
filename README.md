# CohortLens

本地优先的结构化测评工具，面向小型团队、兴趣共同体与协作组织。

系统通过 **题库 → 分层随机组卷 → 本地答题 → 本地结构化评分 → 角色适配分析 → 可选 LLM 报告** 形成对候选成员的辅助性理解。

**AI 不定义一个人是谁，而是帮助整理这个人已经主动表达出来的信息。**

本仓库实现的是 **V0.1 最小闭环切片**，不是完整的发布版 MVP。范围边界见下文「本切片做了什么 / 没做什么」。

---

## 30 秒跑起来

```bash
npm install
npm run dev            # 打开 http://localhost:5173
```

不需要任何 API Key、不需要后端、不需要联网即可完成整个测评。

## 只跑核心引擎（不启动浏览器）

```bash
npm run validate:questions     # 校验冻结题库（34 项检查）
npm run validate:config        # 校验 ProductConfig 与内容一致性、扫描密钥泄漏
npm run demo:assessment        # 端到端跑一份真实结果 + 确定性自检
npm run gate:local             # 一次跑完全部本地闸门
```

`demo:assessment` 会在 `exports/demo-assessment-result.json` 导出结构化结果。作答是**模拟数据**（由种子驱动，不是真人），理由见 `docs/decisions/ADR-009`。

## 工程闸门

| 命令 | 覆盖 |
|---|---|
| `npm run lint` | ESLint 9 flat config + TypeScript 规则 |
| `npm run format:check` | Prettier（`content/` 被排除，冻结内容不得被重排） |
| `npm run typecheck` | `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| `npm run test` | Vitest：112 个测试 |
| `npm run test:coverage` | 核心引擎（`src/engine`、`src/domain`）行覆盖阈值 90% |
| `npm run build` | 静态产物输出到 `dist/` |
| `npm run validate:questions` | 题库/评分/角色模型一致性 |
| `npm run validate:config` | 配置与内容一致性、密钥泄漏扫描 |
| `npm run demo:assessment` | 端到端 + 确定性证明 |

CI（`.github/workflows/ci.yml`）在 push / PR 时执行同样的检查，并额外断言：
- 构建产物不出现裸 `/assets/` 绝对路径；
- 默认构建保持相对路径，可直接从任意静态位置打开；
- 仓库中不存在疑似 API Key。

## 目录结构

```
cohortlens/
├─ content/                     ← 甲方专属内容，改这里而不是改 src/
│  ├─ question-packs/v1/        ← 冻结题库（源文件逐字节副本，SHA-256 已校验）
│  ├─ scoring/v1/               ← 评分模型
│  ├─ roles/v1/                 ← 角色模型
│  └─ prompts/report/           ← （待补）报告 Prompt
├─ docs/decisions/              ← ADR-001 ~ ADR-010
├─ scripts/                     ← validate-question-pack / validate-config / demo-assessment
├─ src/
│  ├─ app/                      ← App 外壳、路由、Zustand store
│  ├─ components/               ← （预留）
│  ├─ content/                  ← 内容加载 + Zod 校验
│  ├─ config/                   ← ProductConfig、隐私说明、边界说明
│  ├─ domain/                   ← Schema、校验器、纯文本报告渲染
│  ├─ engine/                   ← rng / sampler / scoring / consistency / role-fit / assessment
│  ├─ pages/                    ← Home / Assessment / Result / About
│  └─ utils/
└─ tests/                       ← unit / integration / fixtures
```

## 换一套系统（Fork Friendly）

工程圣经 §63 要求甲方特有内容尽量放 `content/` 而非 `src/`。当前需要改的只有：

| 想换什么 | 改哪里 |
|---|---|
| 产品名称、副标题、描述 | `src/config/product.ts` → `PRODUCT_CONFIG.name`（唯一真源，不写死在业务代码里） |
| 题库 | 替换 `content/question-packs/v1/question-pack-v1.0.json`，并同步 `PRODUCT_CONFIG.assessment.questionPackId` |
| 评分维度与归一化 | `content/scoring/v1/scoring-model-v1.0.json` |
| 角色与权重 | `content/roles/v1/role-model-v1.0.json` |
| 隐私说明 / 边界说明文案 | `src/config/product.ts` → `PRIVACY_NOTICE` / `RESULT_BOUNDARY_NOTICE` |
| 部署子路径 | 构建时设 `VITE_BASE=/repo-name/` |

替换内容后必须跑 `npm run validate:questions`，它会拦下配额凑不齐、维度不匹配、评分键非法等问题。

## 产品边界（硬约束，不可通过配置关闭）

以下由代码强制，不是文档约定：

- **不输出单一总分。** 输出的是维度画像（Profile Vector）。测试会遍历结果对象，断言不存在 `total` / `overallScore` / `composite` 等字段。
- **理论层（A 层）不参与角色适配。** 不是靠约定，而是 `computeRoleFits` 在加权前结构性过滤掉 A 层；`auditRoleModel` 在运行期静态审计权重表，发现 A 层维度即报告违规。
- **理论层不得解释为政治立场、政治忠诚、政治可靠性或意识形态纯度。** 校验器还会把一致性组备注里的政治/立场类标签作为警告报出来（本版题库的 `CG08` 命中）。
- **一致性引擎不输出"撒谎概率/欺骗指数/真实性评分"。** 只有「回答一致性 / 回答稳定度 / 需要进一步了解」三种表述。
- **禁用输出语言按并集强制执行**（`REQUIRED_FORBIDDEN_LANGUAGE`），覆盖冻结文件里漏掉的 `值得信任` / `不值得信任` / `危险人物` / `撒谎概率` 等。
- **无 API Key 进入仓库。** CI、`.gitignore` 与 `validate:config` 三处都拦。Key 只存在于当前会话，页面关闭即清除。

## 已知限制（如实标注，不是缺陷掩饰）

这些是**实测出来**的限制，已写进结果页与校验报告：

1. **C 层每维只抽 1 题**，归一化分数只能取 2–3 个值（如 `0 / 33 / 100`）；抽到"最低档也计 1 分"的题时连 0 分都取不到。**B 层有 3 个维度每次也只有 1 题。** 系统对每个这样的维度输出可达取值集合与警告，不假装是细粒度测量。
2. **难度平衡阶段未激活**：120 题 `difficulty` 全部为 2。
3. **同族冲突过滤阶段未激活**：120 题 `familyId` 全部唯一。
4. **反向题一致性检测阶段未激活**：120 题 `reverse` 全部为 false。且 `A011` / `A059` 是反向表述却未标记，若有代码"纠正"反向题会静默倒转这两题的分数。
5. **答案位置高度不均**：满分选项在位置 B 的占 76.7%。运行时靠 `optionShuffle` 缓解，但人工审阅版题库（md）会直接暴露答案位置。
6. **全部 120 题都只有一个选项取到满分**（其余选项 ≤ 1），表面效度上"只有一个明显好答案"。源 README 已承认此设计取舍，但不能当作已解决的测量问题。
7. **`confidence` 不是统计置信区间**。它是"覆盖度 × 一致性惩罚"，只回答"这次问卷有没有足够材料谈这个维度"。定义见 `ADR-008`。
8. **11 道题的题干以"通常？"结尾而缺少谓语**（`B003, B006, B019, B022, B028, B030, C004, C010, C015, C017, C019`），答题者需要靠选项反推问题含义。
9. **`CG08` 的备注 `minority voice and internal pluralism`** 会把个人层面的政治多元性推断贴在答题者身上。规则本身只降低置信度，但建议改名（`ADR-005`、校验器 `consistency_group_political_label`）。

## 本切片做了什么

- ✅ 题库 → 分层随机组卷 → 本地答题 → 本地评分 → 角色适配 → 结构化结果 → UI 展示 → 打印/PDF 样式
- ✅ 抽题引擎 7 个阶段全部实现，未激活的阶段如实标注
- ✅ 确定性核心：同 seed 两次独立进程运行，导出 JSON 的 SHA-256 完全相同
- ✅ Schema First：内容全部经 Zod 校验，写错在启动时立刻失败
- ✅ base path 可配置：默认相对路径，`VITE_BASE=/cohortlens/` 产出带前缀路径
- ✅ ADR-001 ~ ADR-010

## 本切片**没有**做（下一步工作，不是遗漏）

| 项 | 状态 | 说明 |
|---|---|---|
| 答题进度持久化（IndexedDB） | 待接入 | 引擎已刷新安全（`questionIds` 与选项顺序冻结进会话，`assessment-flow.test.ts` 已证），缺的只是存储层。当前刷新会重新开始。 |
| History 页面 | 待接入 | 依赖持久化层 |
| JSON 导出按钮 / 历史导出 | 待接入 | 引擎结果已是可序列化对象，CLI 已能导出 |
| PWA（manifest / service worker / 图标） | 未开始 | 发布闸门 §40 未满足 |
| Provider 层（BYOK、Test Connection、模型列表） | 未开始 | 接口形状见 ADR-004；`content/providers/providers.json` 未创建 |
| LLM 报告链路 | 未开始 | Prompt、Payload 最小化、失败降级 UI，见 ADR-003 |
| Settings 页面 | 未开始 | |
| GitHub Pages 实际部署 | 未执行 | workflow 已就绪且默认不触发。**注意：公开部署等于公开 120 题全文与全部评分规则**（源 README 第 85 行）。当前决策是先只保证 basePath 兼容。 |
| Playwright E2E | 未开始 | 浏览器二进制未安装 |
| 中心数据库 / 账号 / 后台 / RAG / Agent / Tauri / Electron | 明确不做 | 工程圣经 §67 Backlog |

## 版本

- 应用：`v0.1.0`（SemVer，§45）
- 题库：`cohortlens-cn-v1@1.0.0`
- 评分：`scoring-v1@1.0.0`
- 角色模型：`roles-v1@1.0.0`

## 数学分数不代表什么

分数只在当前题库体系内部有意义，**不是人口常模，不是百分位，不是对人的判断**。跨题一致性只描述答卷内部的方向差异。最终判断由人结合原始回答作出。

## 许可

未定（占位）。在冻结之前不要假定任何开源许可。
