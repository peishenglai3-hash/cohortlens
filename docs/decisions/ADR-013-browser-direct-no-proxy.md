# ADR-013 — BrowserDirect 就是浏览器直连；跨域失败不做任何绕过

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

有些服务商不允许浏览器直接调用（CORS 策略、明确禁止客户端 BYOK）。遇到的第一个诱因就是"加一个临时小代理"。

Local MVP brief §15 明确禁止：不要 hack，不要建立临时 Proxy Server，要显示明确提示。

## 决策

`BrowserDirectTransport` 只做一件事：带着 `Authorization: Bearer <key>` 直接 `fetch` 用户的端点。

当目标服务不允许浏览器访问时：

- 分类为 `cors_restriction`，UI 显示——"当前服务不允许浏览器直接连接。请更换支持浏览器调用的兼容服务，或等待未来桌面版本的 LocalBridge 支持。不要用临时代理服务器绕过这个限制。"
- 原始错误放进折叠的「技术详情」。
- **没有代理、没有隧道、没有隐藏服务端。**

浏览器实际上无法区分"主机不可达"与"主机返回了但没有 CORS 头"——两者都表现为一个不透明的 `TypeError`。因此 UI 同时说明这两种可能，而不是猜一个。这是诚实，不是含糊。

`LocalBridgeTransport` 的接口保留但 `available = false`，UI 据此禁用该选项并标注"当前不可用"，而不是在请求时才失败（brief §16）。

## 后果

- 官方 OpenAI Key 在浏览器里很可能直接撞 CORS。这是真实约束，预设备注里写明了，UI 也会在选到该预设时给出提示，不做任何绕过。
- 用户可以改选其他兼容服务，或用本机 Ollama（完全不出网）。
- 真机验证的边界很清楚：`testConnection` 的 7 种失败模式全部用 MockTransport 覆盖（含 `cors_restriction`）；**真实第三方端点的直连成功与否，属于人工验收项**，不在自动测试承诺范围内。
