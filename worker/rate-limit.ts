/**
 * 提交接口的极简限流。
 *
 * 必须说清它的能力边界——Workers 的隔离实例**按需创建、随时回收**，内存里的计数既不跨实例
 * 也不持久。所以它不是一道真正的防线，只是让"同一个 IP 在十秒内提交两百次"这种明显异常在
 * 多数情况下被挡掉。真正的防线是邀请码：没有有效码就写不进任何东西。
 *
 * 两个设计细节值得说明，因为它们都是被测试逼出来的：
 *
 *   1. **被拒绝的请求不计数。** 第一版是先记账再校验，于是一串格式错误的请求会把额度吃光，
 *      随后一个完全正常的提交会拿到 429——用户看到的是"提交失败"，而真实原因是他自己前面
 *      几次失败的尝试。校验不通过的请求没有消耗任何服务端资源，不该收费。
 *   2. **计数器可注入。** 第一版是模块级 Map，跑测试时十个用例之后就全部 429，而且失败原因
 *      完全看不出来。可注入之后，每条用例拿到干净的实例，"限流生效"本身也能被单独测。
 */

export interface RateLimitDecision {
  allowed: boolean
  /** 被拒时建议的重试等待秒数；允许时为 0。 */
  retryAfterSeconds: number
}

export interface RateLimiterOptions {
  windowMs: number
  maxPerWindow: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()
  private readonly windowMs: number
  private readonly maxPerWindow: number

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs
    this.maxPerWindow = options.maxPerWindow
  }

  check(key: string, nowMs: number): RateLimitDecision {
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= nowMs) {
      this.buckets.set(key, { count: 1, resetAt: nowMs + this.windowMs })
      // A long-lived isolate would otherwise accumulate one entry per address forever.
      if (this.buckets.size > 5000) this.buckets.clear()
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (bucket.count >= this.maxPerWindow) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - nowMs) / 1000) }
    }
    bucket.count += 1
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

export const SUBMIT_WINDOW_MS = 60_000
export const SUBMIT_MAX_PER_WINDOW = 10

/** Worker 的默认限流器。测试应当自己 new 一个，而不是共用这个。 */
export const defaultSubmitLimiter = new RateLimiter({
  windowMs: SUBMIT_WINDOW_MS,
  maxPerWindow: SUBMIT_MAX_PER_WINDOW,
})
