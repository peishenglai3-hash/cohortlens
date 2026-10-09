# 部署记录（2026-10-09）

本文件记录**实际发生的部署**，与 `public-link.md`（步骤手册）分开：手册说"怎么做"，
这里说"做成了什么、验证到什么程度、哪里还有保留"。

## 线上地址

| 用途 | 地址 |
| --- | --- |
| 作答端（发给候选人） | <https://cohortlens.pages.dev/> |
| 审阅台（只给发起方） | <https://cohortlens-review.peishenglai3.workers.dev/> |
| D1 数据库 | `cohortlens-reviews` · `ed0a3b50-33c1-4e01-b7a1-7e69c2de471e` · region APAC |
| Cloudflare 账号 | `Peishenglai3@gmail.com's Account` · `1e4d0f6a8ec24bfcab9f436de58560df` |

## 已完成的验证（都在线上跑过，不是本地结论）

| 检查 | 结果 |
| --- | --- |
| `GET /api/health` | `{"ok":true,"database":"ok","missingTables":[],"warnings":[]}` |
| 作答端首页 | HTTP 200，`<title>CohortLens</title>` |
| 审阅台首页 | HTTP 200 |
| 无口令读审阅台 | 401 |
| 错误口令读审阅台 | 401 |
| CORS：允许的来源 | `Access-Control-Allow-Origin: https://cohortlens.pages.dev` |
| CORS：形似来源 `cohortlens.pages.dev.evil.test` | 403 |
| 真实提交（30 题 + A 层六部分） | **201 created**，写入 D1 |
| 同一 `clientSubmissionId` 重放 | **200 existing**，同一个 id，**没有产生第二条记录** |
| 无效邀请码提交 | 403 `invite_not_found`，未写入 |
| 自带 `summary` 字段的提交 | 400 `invalid_submission: Unrecognized key(s) in object: 'summary'` |
| D1 实际行数 | `submissions=1`、`invite_codes=1`、码已用 1 次 |
| 存下来的摘要版本 | `summary_version=2` |

## 网络可达性的一条实测结论

`cohortlens-review.peishenglai3.workers.dev` 解析到 `31.13.70.9` / `2a03:2880:f134:183:face:b00c::/48`。
`face:b00c` 是 Cloudflare 自己的标记，所以这不是 DNS 污染——**Cloudflare 的真实应答就落在这个段**。

实测（各 6 次，12 秒超时）：

| 主机 | 成功 | 平均耗时 |
| --- | --- | --- |
| `*.workers.dev` | 6/6 | 418 ms |
| `*.pages.dev` | 5/6 | 520 ms |

结论：**两个都通**，但 Node 的 `fetch`（undici）会优先尝试 IPv6，而本机 IPv6 到该段不通，
于是表现为 `ConnectTimeoutError`。用 PowerShell / curl（走 IPv4）一切正常，真实浏览器也会走 IPv4。

> 这是一条环境事实，不是产品缺陷。但它意味着：**用 Node 脚本测这两个域名时要用 `--dns-result-order=ipv4first`
> 或改用 curl**，否则会看到并不存在的"部署失败"。

## 已知保留项

1. **审阅台口令**由部署时随机生成，保存在 `%USERPROFILE%\.cohortlens-admin-token.txt`，
   同时是 Cloudflare 上的 secret `ADMIN_TOKEN`。要换：`npx wrangler secret put ADMIN_TOKEN`。
2. **没有账号系统**：一个口令就是全部权限。多人协作前应换成 Cloudflare Access。
3. **`ALLOWED_ORIGINS` 目前只列了 `cohortlens.pages.dev` 与一个预览域名**。
   Pages 每次部署会产生一个新的 `<hash>.cohortlens.pages.dev`，用那些地址访问时提交会被拒；
   需要长期支持预览地址的话，往 `wrangler.toml` 的 `ALLOWED_ORIGINS` 里加通配域名并重新部署 Worker。
4. **`wrangler.toml` 与 `application.json` 里现在存的是真实 id 与真实域名。** 仓库是私有的；
   这两个值不是凭据（凭据只有 `ADMIN_TOKEN` 与 `api_key`，都不在仓库里），但换账号时要记得改。
5. **库里有 1 条测试提交**（`prod-check@example.com`）。开始正式收集前应当在审阅台里撤回或删除它。
