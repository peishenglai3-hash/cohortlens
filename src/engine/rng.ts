/**
 * Deterministic pseudo-random number generation.
 *
 * Engineering Bible §12 requires a seeded, reproducible 120 -> 30 draw: the same seed plus the
 * same question pack must always produce the same question set. `Math.random` is therefore
 * banned from the sampler (see ADR-006). The generator is a self-contained mulberry32 PRNG so
 * that reproducibility never depends on a platform CSPRNG or on Node/web crypto availability.
 */

/** FNV-1a 32-bit string hash. Stable across Node, browsers and platforms. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    // h *= 16777619, kept in 32-bit unsigned range without BigInt.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number
  /** Fisher-Yates on a copy; the input array is never mutated. */
  shuffle<T>(items: readonly T[]): T[]
  /** Uniform pick on a copy; the input array is never mutated. */
  pick<T>(items: readonly T[]): T
  /** Uniform sample of `count` distinct items; throws when `count` exceeds the pool. */
  sample<T>(items: readonly T[], count: number): T[]
}

export function createRng(seed: string): Rng {
  let state = hashSeed(seed)

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt expects a positive integer, received ${maxExclusive}`)
    }
    return Math.floor(next() * maxExclusive)
  }

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = nextInt(i + 1)
      const a = out[i] as T
      const b = out[j] as T
      out[i] = b
      out[j] = a
    }
    return out
  }

  const sample = <T>(items: readonly T[], count: number): T[] => {
    if (count < 0) throw new RangeError(`sample count must be >= 0, received ${count}`)
    if (count > items.length) {
      throw new RangeError(`sample of ${count} requested from a pool of ${items.length}`)
    }
    return shuffle(items).slice(0, count)
  }

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('pick from an empty array')
    return items[nextInt(items.length)] as T
  }

  return { next, nextInt, shuffle, pick, sample }
}
