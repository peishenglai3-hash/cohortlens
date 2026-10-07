# ADR-011 — 持久化通过 Repository 层，组件不直接碰 IndexedDB

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

Local Full Flow 要求"逐题自存、刷新恢复、关闭后继续、历史记录可查看/导出/删除"。把 IndexedDB 调用散进 React 组件会带来三个后果：无法测试、无法迁移、以及最糟的一种——某条路径忘了保存。

## 决策

四层，单向依赖：

```
React 组件  →  Zustand store  →  Repository  →  IndexedDB (idb)
```

- `SessionRepository` / `ResultRepository` / `SettingsRepository` / `ReportRepository`，各自只知道自己的对象仓库。
- store 是唯一知道"业务流程"的地方（例如"选完答案立刻落盘"）。
- 组件只 dispatch 意图，不认识数据库。

五个对象仓库：`sessions`、`results`、`settings`、`secrets`、`reports`。`secrets` 与 `settings` **物理分离**，理由见 ADR-012。

读取时用 Zod 复校验（§36）。一条来自旧 schema 的记录会被拒绝加载并抛出说明性错误，而不是被当成有效数据算出一个错的结果。

`dbVersion = 1`，升级阶梯是 append-only：每个版本只新增分支，不改写已有分支。

## 后果

- 仓库层可以用真实（内存版）IndexedDB 测试，而不是手写桩：见 `tests/unit/storage-repositories.test.ts`，14 个测试跑的是真实事务、真实索引、真实升级路径。
- 新增一条持久化路径只需要改仓库 + store，不需要动任何页面。
- 代价：多了一层间接。对一个小应用来说这层很薄（四个类，每个不到 80 行），换来的是"忘记保存"这类 bug 无法藏在组件里。
