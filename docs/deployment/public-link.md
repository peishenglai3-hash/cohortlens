# 公共链接部署手册

> **本项目的部署已经完成。** 实际地址：
>
> | 用途 | 地址 |
> |---|---|
> | 作答链接（发给候选人） | https://cohortlens.pages.dev/ |
> | 审阅台（只给你） | https://cohortlens-review.peishenglai3.workers.dev/ |
> | 数据库 | Cloudflare D1 cohortlens-reviews (ed0a3b50-33c1-4e01-b7a1-7e69c2de471e) |
>
> 下文保留完整步骤，用于换账号、换域名或重建时照做。


给一个**没参与开发**的人用。每一步都写明"为什么"和"成功了长什么样"。

预计时间：25–40 分钟。全部在免费额度内。

---

## 0. 你要得到的东西

| 产出 | 谁用 | 长什么样 |
| --- | --- | --- |
| **作答链接** | 发给候选人 | `https://cohortlens-xxx.pages.dev/#/assessment?invite=XXXX-XXXX-XXXX` |
| **审阅台** | 你自己 | `https://cohortlens-review.<你的账号>.workers.dev/` |

两者是**两个不同的地址**：候选人只看得到作答端，看不到审阅台，也读不到别人的材料。

---

## 1. 前置条件

- 一个 Cloudflare 账号（免费版即可，注册只要邮箱）
- 本机已装 Node.js（`node -v` 有输出即可）
- 本仓库已经 `npm install` 过

> **为什么用 Cloudflare 而不是 GitHub Pages**：GitHub Pages 的官方条款明确禁止把它当作
> "主要面向商业交易或 SaaS 的免费托管"，教学类站点还写明 **must not collect any user data**。
> 我们这一步恰恰是要收集作答数据，用 Pages 做数据接收方在条款上站不住。
> GitHub 仍然可以用作**代码托管与备份**，那部分不受影响。

---

## 2. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出授权页，点允许。

**成功的样子**：终端显示 `Successfully logged in.`

```bash
npx wrangler whoami
```

应当列出你的账号邮箱与 Account ID。

> 如果浏览器打不开或者公司网络拦住 OAuth，改用 API Token：
> 在 Cloudflare 后台 → My Profile → API Tokens → Create Token，选 **Edit Cloudflare Workers** 模板，
> 然后把 token 设进环境变量 `CLOUDFLARE_API_TOKEN`。**不要**把 token 写进任何提交到仓库的文件。

---

## 3. 建数据库

```bash
npm run db:create
```

**成功的样子**：输出里有一行 `database_id = "xxxxxxxx-xxxx-..."`。

把这个 id 填进 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cohortlens-reviews"
database_id = "<刚才那个 id>"
```

注意那一段现在是**注释状态**，要把前面的 `#` 去掉。

然后建表：

```bash
npm run db:migrate
```

**成功的样子**：`🚣 N commands executed successfully.`

> **为什么 database_id 要手动填**：wrangler 需要一个真实存在的库 id 才能部署。
> 把假 id 留在配置文件里会让部署在几周后以一种很难查的方式失败，所以宁可让它空着、
> 由这一步明确填上。

---

## 4. 设审阅台口令

这是**唯一**保护审阅台的凭据。想一个长口令（至少 24 字符，建议用密码管理器生成）：

```bash
npx wrangler secret put ADMIN_TOKEN
```

粘贴口令后回车。

**成功的样子**：`Successfully created secret for key: ADMIN_TOKEN`

> **为什么是 secret 而不是普通变量**：普通变量会明文写在 wrangler.toml 里并进版本库。
> 审阅台能看到所有人的作答与联系方式，口令泄露等于全部材料泄露。
>
> **忘了口令**：重跑上面这条命令覆盖即可。口令只存在 Cloudflare 侧，本地没有任何副本，
> 所以忘了就只能换一个。

---

## 5. 发作答链接（Cloudflare Pages）

先构建：

```bash
npm run build
```

然后创建 Pages 项目并上传产物：

```bash
npx wrangler pages project create cohortlens
npx wrangler pages deploy dist --project-name cohortlens
```

**成功的样子**：输出一个 `https://cohortlens-xxxx.pages.dev` 地址。

打开它，应当能看到 CohortLens 首页。

---

## 6. 部署审阅台 Worker

```bash
npm run build:admin      # 构建审阅台前端
npx wrangler deploy
```

**成功的样子**：输出一个 `https://cohortlens-review.<你的账号>.workers.dev` 地址。

先自检：

```bash
curl https://cohortlens-review.<你的账号>.workers.dev/api/health
```

期望：
```json
{"ok":true,"formatVersion":"1.0","database":"ok","missingTables":[],"warnings":[]}
```

- `"ok":false` 且有 `missingTables` → 第 3 步的 `db:migrate` 没跑成功
- `warnings` 里有 `ALLOWED_ORIGINS` → 第 7 步还没做，现在做

---

## 7. 把作答端地址告诉 Worker（**最容易漏的一步**）

打开 `wrangler.toml`，把第 5 步拿到的 Pages 域名填进 `ALLOWED_ORIGINS`：

```toml
[vars]
ALLOWED_ORIGINS = "https://cohortlens-xxxx.pages.dev"
```

重新部署：

```bash
npx wrangler deploy
```

再查一次 `/api/health`，`warnings` 应当是空数组。

> **为什么必须做**：作答端和 Worker 是两个不同的域名，浏览器会先发跨域预检。
> 不配白名单 ⇒ 所有提交被拒，而作答者只会看到"提交失败"，完全指不到原因。
> 我们不配 `*`，因为那等于允许任何网站代表你的作答者往这台 Worker 提交数据。

---

## 8. 把 Worker 地址写进作答端，然后重新部署 Pages

打开 `application.json`，填上 Worker 地址：

```json
"reviewEndpoint": "https://cohortlens-review.<你的账号>.workers.dev"
```

```bash
npm run build
npx wrangler pages deploy dist --project-name cohortlens
```

**成功的样子**：在 Pages 地址上做完一次测评，结果页底部出现「提交给发起方」面板，
里面有"提交前请确认"的逐条说明。

> 这一步是**构建期固化**的：地址写进产物，所以发出去的链接天生知道该提交到哪里，
> 作答者不需要配置任何东西。

---

## 9. 发一个邀请码

```bash
npm run db:invite -- --label "2026春-社会学-第一批" --max-uses 30 --days 14
```

**成功的样子**：终端打印出邀请码，并给出完整链接：

```
  码     K7M2-P9QR-XT4H-W8ND
  ...
发给作答者的链接形如：
  https://<你的作答端域名>/#/assessment?invite=K7M2-P9QR-XT4H-W8ND
```

把这个链接发给候选人即可。

- `--max-uses 30`：最多 30 人用它提交。不写则不限次数。
- `--days 14`：14 天后失效。不写则不过期。
- `--label`：批次名，会出现在审阅台里，方便日后归档。

---

## 10. 用审阅台

打开 `https://cohortlens-review.<你的账号>.workers.dev/`，粘贴第 4 步的口令。

你会看到：

- **列表**：收到时间、联系方式、批次、材料完成度、你的判断状态
- **点「查看材料」**：材料完成度与逐维证据量、B/C 层维度画像、角色适配、
  A 层六部分原始材料、引擎自己写出的局限性、以及**你自己的判断栏**

判断栏有四个状态（待定 / 想进一步了解 / 材料不足需要补充 / 本轮不合适）和一个理由框。

> **这里没有"是否通过"**。这不是没做完：产品边界明令不输出录用或淘汰建议，
> 审阅台的职责是把你需要的信息一次给全，判断由你作出。
> 想按"谁还没看"筛选，用列表上方的下拉框。

---

## 11. 部署后自检清单

- [ ] `GET /api/health` 返回 `ok: true`、`warnings: []`
- [ ] 用邀请链接在**另一个浏览器**（或无痕窗口）里做完一次测评并提交成功
- [ ] 提交后审阅台列表里出现这一份，联系方式正确
- [ ] 详情页能展开，A 层六部分有内容
- [ ] 写一个判断，刷新后还在
- [ ] **不带口令**直接访问 `/api/review/list`，应当返回 401
- [ ] 用一个**错误的**邀请码提交，应当被拒绝且列表里不多出记录

---

## 12. 出问题时

| 现象 | 多半是 |
| --- | --- |
| 作答者"提交失败"，但网络正常 | `ALLOWED_ORIGINS` 没配或域名写错（第 7 步） |
| 提交返回"邀请码无效" | 链接被截断，或码已过期/用尽（第 9 步重发一个） |
| 审阅台打不开 / 401 | 口令不对；重跑第 4 步覆盖 |
| `/api/health` 报 `missingTables` | `npm run db:migrate` 没跑成功 |
| 详情页某个字段显示异常 | 打开 [ADR-020](../decisions/ADR-020-backend-submission-and-review-console.md) 第 7 节；摘要带版本列，旧行会在读取时自愈 |
| 提交被限流（429） | 一分钟内同一地址超过 10 次；等一分钟 |

看实时日志：

```bash
npx wrangler tail
```

> 注意：`wrangler tail` 会打印请求元数据。提交接口的请求体含真人作答与联系方式，
> 因此本项目默认**不开** observability，只在排查时临时开、查完关。

---

## 13. 这个部署里没有的东西（如实说明）

- **没有账号系统**：审阅台只有一个口令，谁拿到口令谁就能看全部材料。人少时够用，
  多人协作前应当换成 Cloudflare Access。
- **提交后无法由作答者自助删除**：撤回要通过你（审阅台有软删接口，界面上暂未暴露按钮）。
- **没有自动备份**：D1 支持 Time Travel，但它不是备份策略。重要数据请定期
  `npx wrangler d1 export`。
- **免费额度不是无限的**：D1 免费版每天 500 万行读 / 10 万行写。几百份材料远远用不到，
  但如果哪天开始批量导出，注意一下。
