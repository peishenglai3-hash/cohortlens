# ADR-004 — Provider 与 Transport 抽象

状态：Accepted（V0.1，仅落地接口形状）
日期：2026-10-07

## 背景

用户要"填 Key 就能用"，但不同服务商的 CORS 策略、模型列表接口、鉴权头都不一样；同时未来打包成 Tauri 时，Key 应该进入操作系统凭据存储而不是浏览器存储。如果把这些差异写进 React 组件，任何一处变化都会穿透整个 UI。

## 决策

分两层：

```
AIProvider
     ↓
AITransport
     ├─ BrowserDirectTransport   （V0.1）
     └─ LocalBridgeTransport     （未来 Tauri）
```

- `AIProvider` 负责协议语义：`testConnection` / `listModels?` / `generateReport`。
- `AITransport` 负责"请求怎么发出去"以及"Key 存在哪里"。
- React 层只依赖 `AIProvider`，因此更换 transport 不需要改 UI（§33）。

## 后果

- V0.1 只实现 `BrowserDirectTransport`，且只用于明确允许客户端 BYOK 与 CORS 的 OpenAI-compatible 服务。
- 官方 OpenAI 的长期 Key 不应被设计成公开静态站点里的内置凭据（§30）。
- 默认 Key 只存在于当前会话，页面关闭即清除；"记住此设备"必须显示风险提示，且不得宣传"浏览器本地保存绝对安全"（§31）。
- 错误必须映射为人类可读的原因（地址不可达 / Key 无效 / 模型不存在 / 跨域限制 / 服务不可用 / 超时 / 额度不足 / 未知），并折叠"查看技术详情"，不得直接暴露 `Failed to fetch`（§34）。
- 待验证：本切片未实现 Provider 层，`content/providers/providers.json` 与 `src/infrastructure/ai/` 尚未创建。接口形状见《工程圣经》§25/§26/§32。
