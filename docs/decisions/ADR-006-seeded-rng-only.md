# ADR-006 — 种子化 PRNG：禁用 `Math.random`

状态：Accepted（V0.1）
日期：2026-10-07

## 背景

圣经 §10 严禁 `questions.sort(() => Math.random() - 0.5)`，§12 要求同一 seed + 同一题库必须复现同一份问卷，§50 要求测试证明"相同 questionIds + answers + versions 得到完全相同的 Structured Result"。

## 决策

抽题与选项打乱只使用自带的 mulberry32 PRNG，种子先经 FNV-1a 哈希（`src/engine/rng.ts`）。选择自带实现而不是平台 CSPRNG，是为了让可复现性不依赖 Node/浏览器的 crypto 可用性。

派生方式固定为：

| 用途 | 种子 |
|---|---|
| 层级抽题（第 n 次重抽） | `"<seed>::<layer>::attempt::<n>"` |
| 难度平衡 | `"<seed>::difficulty::<layer>"` |
| 选项顺序 | `"<seed>::options::<questionId>"` |
| 演示作答（仅 demo） | `"<seed>::simulate::<questionId>"` |

## 后果

- 换 seed ⇒ 换卷；同一 seed ⇒ 逐字节相同的卷与结果。已验证：两次独立进程运行的导出 JSON SHA-256 完全一致；同 seed 换 seed 后题目重合 8/30。
- `tests/unit/sampler.test.ts` 直接把 `Math.random` 替换成抛异常的桩，防止未来重构静默引入不确定性。
- 重抽机制（family 约束）用 `attempt` 计数派生新种子，因此"重抽"本身也是确定性的。
- 代价：PRNG 不是密码学安全的。它只用于组卷，不用于任何密钥、令牌或身份相关用途。
