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

## 甲方交付（定制 PWA 版本）

甲方收到后要能"直接用"，所以交付物有两种形态、各配一条命令：

```bash
npm run build:delivery     # 单文件离线版 -> dist-delivery/index.html
npm run pack:delivery      # 组装完整交付包 -> delivery/CohortLens-交付包/
npm run verify:delivery    # 从外部独立验收交付包（16 项检查）
```

`pack:delivery` 产出的目录：

| 路径 | 是什么 |
|---|---|
| `CohortLens.html` | **单文件离线版**。双击即用，全部 JS/CSS/题库内联在一个文件里，无任何外部引用 |
| `app/` | 标准静态站点（PWA），可安装、可离线；配 `server.cjs` 起 http 即可 |
| `启动本地服务器.cmd` | Windows 双击启动（内部调 `server.cjs`，零 npm 依赖） |
| `0-先看这里.md` | 给甲方的最简说明：两种打开方式、数据在哪、边界是什么 |
| `技术说明.md` | 版本号、构建来源、已验证/未验证清单 |
| `SHA256SUMS.txt` | 全部交付文件的 SHA-256 |

单文件版从 `file://` 打开时没有安全上下文，浏览器不允许注册 Service Worker，因此
`vite.config.delivery.ts` **完全不加载 VitePWA**，并把 `virtual:pwa-register` 指向一个 no-op stub；
`__COHORTLENS_PWA_ENABLED__` 在构建期被替换为 `false`。这不是权宜之计——单文件本身已经离线，
Service Worker 在它身上没有作用。

Playwright 里有一条专门的 spec（`tests/e2e/delivery-single-file.spec.ts`）用 `file://` 真打开
交付文件，断言：首页能渲染、**零外部请求、零失败请求**、能走完抽题→作答→结果→历史、
产物里不含任何 Service Worker 代码。

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

## 公共链接（作答端 + 审阅台）

把测评发给候选人，并在一处收齐所有材料。两套产物，两个地址：

| 产物 | 部署到 | 命令 |
|---|---|---|
| 作答端（现有静态站） | Cloudflare Pages | `npm run build` + `npx wrangler pages deploy dist --project-name cohortlens` |
| Worker + 审阅台 | Cloudflare Workers + D1 | `npm run build:admin` + `npx wrangler deploy` |

完整步骤见 [公共链接部署手册](docs/deployment/public-link.md)（写给没参与开发的人）。

```bash
npm run build:admin        # 构建审阅台前端 -> worker/assets/
npm run typecheck:worker   # Worker 单独一份 tsconfig（workerd 环境没有 DOM）
npm run db:create          # 建 D1 库（一次性）
npm run db:migrate         # 建表
npm run db:invite -- --label "第一批" --max-uses 30 --days 14
```

本地把整条链路跑起来（作答端 + Worker + D1，不需要 Cloudflare 账号）：

```bash
npx wrangler d1 execute cohortlens-reviews --local --config wrangler.local.toml --file=worker/schema.sql
npx wrangler dev --config wrangler.local.toml --port 8791
```

然后 Playwright 的 `tests/e2e/submission-flow.spec.ts` 会真的走一遍
"作答 → 提交 → Worker → D1 → 审阅台读回 → 写判断"；Worker 没起时整组跳过，不会假通过。

**审阅台不替任何人做判断。** 它呈现材料、要求审阅人自己写理由，没有"通过/不通过"这一栏——
这是产品边界，不是未完成项。详见 [ADR-020](docs/decisions/ADR-020-backend-submission-and-review-console.md)。

## 工程闸门

| 命令 | 覆盖 |
|---|---|
| `npm run lint` | ESLint 9 flat config + TypeScript 规则 |
| `npm run format:check` | Prettier（`content/` 被排除，冻结内容不得被重排） |
| `npm run typecheck` | `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| `npm run test` | Vitest：204 个单元/集成测试 |
| `npm run test:coverage` | 核心引擎（`src/engine`、`src/domain`）行覆盖阈值 90% |
| `npm run build` | 静态产物 + PWA（manifest + service worker） |
| `npm run validate:questions` | 题库/评分/角色模型一致性（46 项检查，含 6 项 A 层 V1.1 结构检查） |
| `npm run validate:config` | 配置与内容一致性、密钥泄漏扫描 |
| `npm run e2e` | Playwright 本地端到端（主流程 / AI 报告 / 离线 / PWA / 打印） |
| `npm run verify:delivery` | 交付包独立验收：哈希、http 服务、单文件自包含性、凭据扫描 |
| `npm run typecheck:worker` | Worker 单独类型检查（workerd 环境，不含 DOM 全局） |

## 目录结构

```
cohortlens/
├─ application.json             ← 产品名称唯一来源（web manifest 与标题都从这里派生）
├─ content/                     ← 甲方专属内容，改这里而不是改 src/
│  ├─ question-packs/v1/        ← 现行题库 v1.1（源文件逐字节副本，SHA-256 已校验）
│  ├─ question-packs/_legacy-v1.0/ ← V1.0 题库，仅供溯源，不再被 import
│  ├─ scoring/v1/               ← 评分模型 v1.1 + A 层政策 + A 层结果形状
│  ├─ scoring/_legacy-v1.0/     ← V1.0 评分模型，仅供溯源
│  ├─ roles/v1/                 ← 角色模型（V1.0/V1.1 相同）
│  ├─ providers/providers.json  ← Provider 预设
│  └─ prompts/report/v2.md      ← 报告 Prompt（人类可读镜像；v1.md 保留为历史）
├─ docs/decisions/              ← ADR-001 ~ ADR-019
├─ docs/migration/              ← 内容迁移说明（如 A 层 V1.0 -> V1.1）
├─ docs/deployment/             ← 公共链接部署手册
├─ worker/                      ← Cloudflare Worker：提交接口 + 审阅台后端 + D1 schema
├─ admin/                       ← 审阅台前端（独立产物，构建到 worker/assets/）
├─ delivery/                    ← 甲方交付包（构建产物，gitignored）
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
| 题库 | 替换 `content/question-packs/v1/question-pack-v1.1.json`，同步 `PRODUCT_CONFIG.assessment.questionPackId` |
| 评分维度与归一化 | `content/scoring/v1/scoring-model-v1.1.json` |
| A 层呈现政策与禁止输出 | `content/scoring/v1/a-scoring-model-v1.1.json` |
| A 层结果形状 | `content/scoring/v1/a-result-schema-v1.1.json` |
| 角色与权重 | `content/roles/v1/role-model-v1.0.json` |
| Provider 预设 | `content/providers/providers.json` |
| 部署子路径 | 构建时设 `VITE_BASE=/repo-name/` |
| 交付包说明文案 | `scripts/pack-delivery.ts` 里的 `0-先看这里.md` 模板 |

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

### 内容层（A 层 V1.1 更换后重测）

A 层素材于 2026-10-08 按甲方决定整体更换为 V1.1（`content/question-packs/v1/question-pack-v1.1.json`）。
逐题比对确认：**B / C 层 60 道题与 V1.0 完全相同**（id 集合相同，无一道题有差异），
`layerB` / `layerC` / `scale` / `interpretationBands` 也完全相同；差异只在 A 层 60 道题与
一致性组（V1.0 的 `CG05`–`CG08` 全部引用 A 层题目，已删除）。
下表是**在现行 V1.1 题库上实测**的结果，不是沿用 V1.0 的结论：

1. **C 层每维只抽 1 题**，归一化分数只能取 2–3 个值（如 `0 / 33 / 100`）；**B 层有 3 个维度每次也只有 1 题**。系统对每个这样的维度输出可达取值集合与警告。
2. **A1 单次只有 3 题**，永远是低精度提示；结果页与打印稿都在分数旁边写出来。
3. **A 层有 48 道题按设计不参与数值计分**（A0 的 8 道自我申报 + A2–A5 的 40 道描述性题目）。它们的 `scoring` 为空是**显式设计**，不是缺数据；系统以"不产生分数"呈现，绝不显示 `0`。
4. **难度平衡阶段现已激活**（A 层难度为 1/2/3 混合），但仍有 13 道题的最低选项分值大于 0，对应维度的 0 分档不可达。
5. **同族冲突过滤阶段现已激活**：A 层同一子主题共用一个 `familyId`，引擎按"同一维度内每族只取一次"抽样（ADR-018）。
6. **反向题一致性检测阶段未激活**：现行题库 120 题 `reverse` 全部为 false。V1.0 的 `A011` / `A059` 反向表述问题随 A 层更换消失。
7. **计分题答案位置仍不均**：72 道计分题中满分选项在位置 B 的占 54.2%（V1.0 为 76.7%）。A1 的 12 道概念题已人工均衡为 A/B/C/D 各 3 次；其余题靠按题目策略处理选项顺序缓解（A0 固定、A1/A4/A5 打乱、A2/A3 只允许整体反转）。
8. **全部 72 道计分题都只有一个选项取到满分**（其余选项 ≤ 1）。
9. **11 道题的题干以"通常？"结尾而缺少谓语**（`B003, B006, B019, B022, B028, B030, C004, C010, C015, C017, C019`）——均在 B/C 层，本次未改。
10. **V1.0 的历史会话无法用当前构建重算。** 评分模型与题库版本都变了，版本守卫会明确拒绝（`scoringVersion 1.0.0 ≠ 1.1.0`）而不是换一套规则静默重算。这是刻意的：宁可拒绝，也不要给出一个用错规则算出来的数字。历史记录本身仍可打开、查看当时的作答、当时的分数快照与证据题号。需要注意，即使 B/C 题目完全相同，V1.0 会话的 B/C 分数**也无法逐位复现**：V1.0 的 `CG05`–`CG08` 里有跨 A/B 的一致性组，它们会下调相关 B 维度的置信度，而这些组在 V1.1 已删除。详见 `docs/migration/a-layer-v1.1.md`。

以上各条全部保留在 Known Content Issues 中，**不在工程阶段修改题库**（ADR-005、ADR-016）。`npm run validate:questions` 每次都把它们作为 Warning 报出来，不会沉默，也不会阻止本地构建。

### 后端层（公共链接阶段引入）

11. **审阅台只有一个口令，没有账号系统。** 拿到口令就能看到全部材料。人少时够用，多人协作前应换成 Cloudflare Access。
12. **作答者不能自助撤回。** 撤回接口存在（软删），但界面上没暴露；需要业主在审阅台侧操作。
13. **D1 免费额度有每日上限**（500 万行读 / 10 万行写，自 2026-09-01 起超限直接报错到 UTC 零点）。几百份材料远用不到，但批量导出要注意。
14. **摘要存的是派生数据，带版本列。** 形状演进时旧行在读取时用正文重建并回写（自愈），但重建需要那次查询带上正文，因此列表与详情各有一条修复路径。
15. **本地 Worker 的验收端口是 8791**，不是 wrangler 默认的 8787——本机上 8787 被另一个进程占用。这是环境事实，不是配置要求。

### 工程层

16. **`confidence` 不是统计置信区间**，而是"覆盖度 × 一致性惩罚"（ADR-008）。
17. **真实第三方端点的直连成功与否属于人工验收**。自动测试覆盖 7 种失败模式的分类，不承诺某个具体服务商在浏览器里可用（ADR-013）。
18. **移动端 viewport 的 E2E 只在 Chromium 上跑过**，未在真实 iOS/Android 设备上验证。

## 发布轨道

公共链接这一步**已经实现并本地验证**（作答 → Worker → D1 → 审阅台全链路有 E2E 覆盖），
但**尚未部署到任何真实域名**：Cloudflare 需要业主自己的账号凭据，本机没有，
这是唯一剩下的阻塞项。见 [部署手册](docs/deployment/public-link.md)。

```
GitHub Runner / Remote CI    — Deferred（本地闸门够用，不引入远端 CI）
GitHub Pages deployment      — 不使用（条款禁止把 Pages 用作收集用户数据的服务，见 ADR-020）
Cloudflare Pages 部署        — 待业主账号（唯一阻塞项）
Cloudflare Workers 部署      — 待业主账号（唯一阻塞项）
```

`.github/workflows/ci.yml` 与 `deploy-pages.yml` **保留**，状态是 *Prepared / Not remotely verified*。`deploy-pages.yml` 为 manual-only，不会自动触发。上游的 base path 支持、静态构建支持、workflow 文件都**没有删除**，只是本阶段不投入工程时间。

本阶段同样不做：账号系统（审阅台只有一个口令）、Tauri / Electron、Cloud Sync、Team Dashboard、RAG、Agent、Analytics Platform。
中心数据库**已按需引入**：一个 Cloudflare D1，只存提交与审阅结论，见 ADR-020。

## 版本

- 应用：`v0.1.2`（SemVer）
- 题库：`cohortlens-question-pack-v1.1@1.1.0`（A 层 V1.1）
- 评分：`scoring-v1.1@1.1.0`
- 角色模型：`roles-v1@1.0.0`（未变）
- 报告 Prompt：`report-prompt-v2`
- 提交格式：`cohortlens-submission@1.0`
- 审阅摘要存储版本：`2`（`submissions.summary_version`）
- Git 标签：`engine-slice-v0.1`（仅引擎，已验收）、`local-mvp-v0.1`（Local MVP）、`a-layer-v1.1`（A 层更换）、`public-link-v0.1`（公共链接 + 审阅台）

## 数学分数不代表什么

分数只在当前题库体系内部有意义，**不是人口常模，不是百分位，不是对人的判断**。跨题一致性只描述答卷内部的方向差异。最终判断由人结合原始回答作出。

## 许可

未定（占位）。在冻结之前不要假定任何开源许可。
