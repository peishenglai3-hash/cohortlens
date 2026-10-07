# CohortLens

本地优先的结构化测评工具，面向小型团队、兴趣共同体与协作组织。

系统通过 **题库 → 分层随机组卷 → 本地答题 → 本地结构化评分 → 角色适配分析 → 可选 LLM 报告** 形成对候选成员的辅助性理解。

**AI 不定义一个人是谁，而是帮助整理这个人已经主动表达出来的信息。**

当前状态：**Local MVP（本地全链路可用）**。没有中心服务器、没有账号、没有云端；发布轨道（GitHub Runner / Pages / Remote CI）**冻结为 Deferred**，见文末。

---

## 30 秒跑起来

```bash
npm install
npm run dev            # 打开 http://localhost:5173
```

不需要任何 API Key、不需要后端、不需要联网即可完成整个测评。

## 完整本地流程（不需要任何控制台操作）

```
首页 → 开始测评 → 随机 30 题 → 逐题作答（每题立即保存）
     → 中途刷新/关闭浏览器 → 回到首页「继续上次测评」
     → 完成 → 本地算出 Structured Result → 画像 + 角色适配 + 证据
     → 历史记录 → 查看 / 继续 / 删除 / 导出 JSON
     → 设置 → 选服务商 + 粘 API Key → 测试连接
     → 生成 AI 综合报告（可选；也可先用「本地示例（不联网）」跑通）
     → 打印 / 另存为 PDF
     → 断网后仍可打开、答题、评分、查历史、导出
```

## 命令

```bash
npm run gate:local        # 全部本地闸门：lint + format + typecheck + 两个校验器 + 覆盖率 + 本地 E2E
npm run gate:local:fast   # 同上但跳过 E2E（快速回归）
npm run e2e               # 构建后跑 Playwright（桌面 + 移动两个 project，仅本机）
npm run validate:questions # 校验冻结题库（34 项检查）
npm run validate:config    # 校验 ProductConfig 与内容一致性、扫描密钥泄漏
npm run demo:assessment    # 命令行端到端跑一份真实结果 + 确定性自检
```

`demo:assessment` 会在 `exports/demo-assessment-result.json` 导出结构化结果。作答是**模拟数据**（由种子驱动，不是真人），理由见 `docs/decisions/ADR-009`。

## 工程闸门

| 命令 | 覆盖 |
|---|---|
| `npm run lint` | ESLint 9 flat config + TypeScript 规则 |
| `npm run format:check` | Prettier（`content/` 被排除，冻结内容不得被重排） |
| `npm run typecheck` | `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| `npm run test` | Vitest：150 个单元/集成测试 |
| `npm run test:coverage` | 核心引擎（`src/engine`、`src/domain`）行覆盖阈值 90% |
| `npm run build` | 静态产物 + PWA（manifest + service worker） |
| `npm run validate:questions` | 题库/评分/角色模型一致性 |
| `npm run validate:config` | 配置与内容一致性、密钥泄漏扫描 |
| `npm run e2e` | Playwright 本地端到端（主流程 / AI 报告 / 离线 / PWA / 打印） |

## 目录结构

```
cohortlens/
├─ application.json             ← 产品名称唯一来源（web manifest 与标题都从这里派生）
├─ content/                     ← 甲方专属内容，改这里而不是改 src/
│  ├─ question-packs/v1/        ← 冻结题库（源文件逐字节副本，SHA-256 已校验）
│  ├─ scoring/v1/               ← 评分模型
│  ├─ roles/v1/                 ← 角色模型
│  ├─ providers/providers.json  ← Provider 预设
│  └─ prompts/report/v1.md      ← 报告 Prompt（人类可读镜像）
├─ docs/decisions/              ← ADR-001 ~ ADR-015
├─ scripts/                     ← validate-question-pack / validate-config / demo-assessment
├─ src/
│  ├─ app/                      ← App 外壳、路由、Zustand store、service worker 注册
│  ├─ config/                   ← ProductConfig、ProviderConfig、隐私与边界文案
│  ├─ content/                  ← 内容加载 + Zod 校验
│  ├─ domain/                   ← Schema、校验器、边界词表、纯文本报告渲染
│  ├─ engine/                   ← rng / sampler / scoring / consistency / role-fit / assessment
│  ├─ infrastructure/
│  │  ├─ storage/               ← IndexedDB + 四个 Repository
│  │  ├─ ai/                    ← Provider / Transport / Prompt / Payload / 报告服务
│  │  └─ export/                ← JSON 导出与导出前审计
│  ├─ pages/                    ← Home / Assessment / Result / History / Settings / About
│  └─ utils/
└─ tests/
   ├─ unit/ integration/ fixtures/   ← Vitest
   └─ e2e/                           ← 本地 Playwright
```

## 换一套系统（Fork Friendly）

| 想换什么 | 改哪里 |
|---|---|
| 产品名称 | `application.json` 的 `name` / `shortName`（PWA manifest 与页面标题同源） |
| 副标题 / 描述 / 隐私说明 / 边界说明 | `src/config/product.ts` |
| 题库 | 替换 `content/question-packs/v1/question-pack-v1.0.json`，同步 `PRODUCT_CONFIG.assessment.questionPackId` |
| 评分维度与归一化 | `content/scoring/v1/scoring-model-v1.0.json` |
| 角色与权重 | `content/roles/v1/role-model-v1.0.json` |
| Provider 预设 | `content/providers/providers.json` |
| 部署子路径 | 构建时设 `VITE_BASE=/repo-name/` |

替换内容后必须跑 `npm run validate:questions` 与 `npm run validate:config`。

## 产品边界（硬约束，不可通过配置关闭）

- **不输出单一总分。** 输出的是维度画像（Profile Vector）。测试会遍历结果对象，断言不存在 `total` / `overallScore` / `composite` 等字段。
- **理论层（A 层）不参与角色适配。** 由 `computeRoleFits` 在加权前结构性过滤，并有 `auditRoleModel` 运行期静态审计。
- **理论层不得解释为政治立场、政治忠诚或意识形态纯度。**
- **一致性引擎不输出"撒谎概率/欺骗指数/真实性评分"。** 只有「回答一致性 / 回答稳定度 / 需要进一步了解」。
- **模型输出过边界过滤器。** 即使模型无视指令输出"值得信任""危险人物""政治可靠"，也会在显示与落盘前被替换为 `[已按产品边界屏蔽]`，并在报告顶部告知用户被屏蔽了几处。
- **API Key 永远不进导出文件。** 导出前做形状扫描，命中即中止导出。
- 结果页不出现 PASS / FAIL / 录取 / 淘汰 / 总分排名。

## 已知限制（如实标注）

### 内容层（题库 V1.0 自身的限制，保持冻结）

1. **C 层每维只抽 1 题**，归一化分数只能取 2–3 个值（如 `0 / 33 / 100`）；**B 层有 3 个维度每次也只有 1 题**。系统对每个这样的维度输出可达取值集合与警告。
2. **难度平衡阶段未激活**：120 题 `difficulty` 全部为 2。
3. **同族冲突过滤阶段未激活**：120 题 `familyId` 全部唯一。
4. **反向题一致性检测阶段未激活**：120 题 `reverse` 全部为 false；且 `A011` / `A059` 是反向表述却未标记。
5. **答案位置高度不均**：满分选项在位置 B 的占 76.7%，靠 `optionShuffle` 缓解。
6. **全部 120 题都只有一个选项取到满分**（其余选项 ≤ 1）。
7. **11 道题的题干以"通常？"结尾而缺少谓语**（`B003, B006, B019, B022, B028, B030, C004, C010, C015, C017, C019`）。
8. **`CG08` 的备注 `minority voice and internal pluralism`** 会把个人层面的政治多元性推断贴在答题者身上，建议改名。
9. 独立内容审计另标出 **7 道 A 层题**的措辞可被读成"考察答题者自身的政治判断"（最重的是 `A021_C 判断受访者没有觉悟`、`A008_A 把不同意见都叫洗脑`）。

以上 9 条全部保留在 Known Content Issues 中，**不在工程阶段修改题库**（ADR-005、ADR-016）。`npm run validate:questions` 每次都把它们作为 Warning 报出来，不会沉默，也不会阻止本地构建。

### 工程层

10. **`confidence` 不是统计置信区间**，而是"覆盖度 × 一致性惩罚"（ADR-008）。
11. **真实第三方端点的直连成功与否属于人工验收**。自动测试覆盖 7 种失败模式的分类，不承诺某个具体服务商在浏览器里可用（ADR-013）。
12. **移动端 viewport 的 E2E 只在 Chromium 上跑过**，未在真实 iOS/Android 设备上验证。

## 明确 Deferred（本阶段不做，也不修）

```
GitHub Runner                — Deferred
GitHub Pages deployment      — Deferred
Remote CI / Remote Secrets   — Deferred
Production PWA Deployment    — Deferred
```

`.github/workflows/ci.yml` 与 `deploy-pages.yml` **保留**，状态是 *Prepared / Not remotely verified*。`deploy-pages.yml` 为 manual-only，不会自动触发。上游的 base path 支持、静态构建支持、workflow 文件都**没有删除**，只是本阶段不投入工程时间。

本阶段同样不做：中心数据库、账号系统、管理后台、Tauri / Electron、Cloud Sync、Team Dashboard、RAG、Agent、Analytics Platform。

## 版本

- 应用：`v0.1.0`（SemVer）
- 题库：`cohortlens-cn-v1@1.0.0`
- 评分：`scoring-v1@1.0.0`
- 角色模型：`roles-v1@1.0.0`
- 报告 Prompt：`report-prompt-v1`
- Git 标签：`engine-slice-v0.1`（仅引擎，已验收）、`local-mvp-v0.1`（本阶段）

## 数学分数不代表什么

分数只在当前题库体系内部有意义，**不是人口常模，不是百分位，不是对人的判断**。跨题一致性只描述答卷内部的方向差异。最终判断由人结合原始回答作出。

## 许可

未定（占位）。在冻结之前不要假定任何开源许可。
