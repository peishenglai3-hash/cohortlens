# ADR-012 — API Key 默认只存在当前会话；持久化是显式 opt-in，且不做假加密

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

用户要"填 Key 就能用"。同时工程圣经 §30 禁止把 Key 写入源码、Git、providers.json、dist 或 GitHub Pages，§31 要求默认只存在当前 Session，并明确**不得宣传"浏览器本地保存绝对安全"**。

Local MVP brief §14 进一步禁止：远程 Key Server、加我们自己的服务器、以及"自己实现毫无意义的本地加密并把解密密钥也存在同一个 JS 环境里"。

## 决策

1. **Key 不是配置的一部分。** `ProviderConfig` 里没有 apiKey 字段；所有 API 都把 Key 作为独立参数传递（`testConnection(config, apiKey)`）。这样"顺手把配置存下来"不可能连带存下 Key。
2. **默认会话级。** `sessionStorage`（标签页关闭即清除，不跨标签共享），带内存兜底以应对存储被禁。见 `src/infrastructure/ai/session-key.ts`。
3. **持久化是显式 opt-in。** 只有勾选「记住此设备」才写入独立的 `secrets` 对象仓库，且必须显示提示："连接信息将保存在当前设备的浏览器数据中，请仅在自己的设备上使用。"
4. **不做假加密。** 不加密 `secrets` 记录，理由写在代码注释里：把解密密钥放在同一个 JS 环境里只是让人误以为安全。UI 也如实说明这是浏览器数据，不是保险箱。
5. **导出永远不含 Key。** `buildExportBundle` 不接收 Key 参数，因此不存在能把它写进导出文件的代码路径；另有 `auditExport` 做第二轮形状扫描（`sk-`、`AIza`、`Bearer`、`apiKey` 等字段名），命中即**中止导出**并提示反馈。
6. **诊断信息不含 Key。** 所有错误分类只输出 HTTP 状态码、端点与响应片段（截断 400 字符），不含请求头。

## 后果

- 关闭浏览器再打开，默认需要重新粘贴 Key。这是刻意的取舍，不是缺陷。
- 测试直接断言这一点：`ai-report.test.ts` 用真实形状的 secret 字符串跑全部 7 种失败模式，断言诊断对象里不含该字符串；E2E 断言导出的 JSON 里不含 `apiKey` / `sk-` / `Bearer`。
- 代价：选择"记住此设备"的用户在一台共享电脑上仍然面临风险。UI 用一句话说清，而不是用复杂弹窗制造安全感。
