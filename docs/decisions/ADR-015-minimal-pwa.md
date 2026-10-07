# ADR-015 — PWA 按最小可用实现：只预缓存外壳，不做运行时缓存策略

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

工程圣经 §40 要求 V0.1 可安装、有 manifest、有图标、具备 basic offline support。Local MVP brief §23 同时明确排除：Push Notification、Background Sync、Remote Update Service、复杂 Cache Strategy。

## 决策

用 `vite-plugin-pwa` 的 `generateSW` 模式，只做三件事：

1. **预缓存**构建产物：`**/*.{js,css,html,png,svg,webmanifest}`（实测 16 项，约 503 KiB）。题库、评分模型、角色模型都是被打包进 JS 的静态导入，因此它们天然被预缓存——这是离线能完成测评的**根本原因**，而不是靠缓存策略。
2. **导航回退**到 `index.html`，让 hash 路由的深层链接在离线时也能打开。
3. **`runtimeCaching: []`**：不写任何运行时缓存规则。本项目没有需要缓存的远程数据；空规则比一条写错的规则更安全。

`registerType: 'autoUpdate'`：新构建在下次加载时接管，不打扰用户。单用户本地工具没有多用户协调要保护。

注册由 `src/app/service-worker.ts` 自己拥有（`injectRegister: null`），并且是**尽力而为**：注册失败只 `console.warn`，应用继续作为普通静态页面工作，离线能力降级而不是应用损坏。

## 后果

- 离线可用是结构性的，不是配置性的：不需要网络的第一阶段评分本来就不发请求。
- 真机验证结果（本地）：service worker 注册并接管成功，断网 reload 后文档仍能渲染，断网可开始新测评、可查历史、可导出。**这不等于"生产部署已验证"**——发布轨道仍然冻结。
- 图标是脚本生成的占位图形（同心环 + CL），不是最终品牌资产。换图标只需替换 `public/icons/` 下的 PNG。
- 代价：增量更新整个预缓存列表（503 KiB）。对本地单用户工具可以接受。
