# ADR-017 — 会话写入串行化：latest-wins 队列

状态：Accepted（Local Full Flow）
日期：2026-10-07

## 背景

Local MVP 要求"选择答案后立即保存"。最直接的实现是每次作答都 `await repository.put(session)`。这在 E2E 中暴露成一个真实的**静默回退**：

用户在快速作答时会有多个写入同时在飞。IndexedDB 对**不同事务**之间不提供顺序保证。于是一个较早的、内容较少的会话状态可能**后于**较晚的状态落盘，把已经答完的进度覆盖回去。症状表现为"我答了 8 题，刷新后只剩 2 题"——而且它不报错。

同一轮还发现两个相关问题：

1. `lastIndex`（读到第几题）最初只存在内存里，刷新会跳回第一题。属于 §54 的"丢失进度"。
2. 结果页在 `finish()` 之后立刻读 DOM 的测试会与异步写入竞争，看起来像持久化坏了。

## 决策

**单一有序写入器 + latest-wins 槽位。**

```
let pendingSession: AssessmentSession | null   // 只保留最新一份
let sessionWriter: Promise<void> | null        // 同一时刻只有一个写入在飞
```

- `enqueueSessionWrite(session)` 覆盖 `pendingSession`，若没有在飞的写入就启动一个排空循环。
- 循环每次取走当前 `pendingSession` 并写一次；写的过程中新入队的会被下一轮取走。
- 中间状态被丢弃。这是正确的：会话是**一条自包含记录**，不是增量日志。
- `flushSessionWrites()` 在队列排空后 resolve，供调用方（和测试）等待落盘而不必猜时间。

会话与结果分别写入时，也走同一条队列，保证"会话里记录的 `resultId`"不会早于结果记录落盘太久。

## 后果

- 所有会话写入路径（`startNew` / `answer` / `goTo` / `finish`）都只经由这一条队列；`goTo` 也把阅读位置折进同一条记录，因此一次写入留下的会话总是内部一致的。
- UI 增加 `saveState`（`idle` / `saving` / `saved` / `error`）并在测评页显示「进度已保存到本机」。这不是装饰：**"已作答"和"已落盘"是两个不同时刻**，把差别显示出来既让用户放心，也让测试不必猜。
- 结果页增加 `persistence-state`，`data-persisted` 在结果真正落盘后才为 `true`。
- 代价：写入被串行化，理论上轻微降低吞吐。对一个单用户本地工具而言这个代价为零；被它挡掉的那类静默数据回退才是真问题。
- 新增单元测试 6 条（`tests/unit/session-persistence.test.ts`）钉住"逐题保存后重载仍在""不重新抽题""旧记录缺 `lastIndex` 时的回退规则"。
