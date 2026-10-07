import { describe, expect, it } from 'vitest'
import { createRng, hashSeed } from '../../src/engine/rng.ts'

describe('rng', () => {
  it('hashSeed is stable and seed-sensitive', () => {
    expect(hashSeed('cohortlens')).toBe(hashSeed('cohortlens'))
    expect(hashSeed('cohortlens')).not.toBe(hashSeed('cohortlens2'))
    expect(hashSeed('')).toBe(0x811c9dc5)
  })

  it('is deterministic for the same seed', () => {
    const a = Array.from({ length: 8 }, () => createRng('seed-a').next())
    const b = Array.from({ length: 8 }, () => createRng('seed-a').next())
    expect(a).toEqual(b)
  })

  it('produces different streams for different seeds', () => {
    const a = createRng('seed-a')
    const b = createRng('seed-b')
    const streamA = Array.from({ length: 8 }, () => a.next())
    const streamB = Array.from({ length: 8 }, () => b.next())
    expect(streamA).not.toEqual(streamB)
  })

  it('stays inside [0, 1) and spreads across the range', () => {
    const rng = createRng('distribution')
    const samples = Array.from({ length: 5000 }, () => rng.next())
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...samples)).toBeLessThan(1)
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
  })

  it('nextInt respects its bound and rejects invalid bounds', () => {
    const rng = createRng('bounded')
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextInt(7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(7)
    }
    expect(() => rng.nextInt(0)).toThrow(RangeError)
    expect(() => rng.nextInt(-1)).toThrow(RangeError)
    expect(() => rng.nextInt(1.5)).toThrow(RangeError)
  })

  it('shuffle covers every element without mutating the input', () => {
    const input = ['a', 'b', 'c', 'd', 'e']
    const rng = createRng('shuffle')
    for (let i = 0; i < 200; i += 1) {
      const output = rng.shuffle(input)
      expect([...output].sort()).toEqual([...input].sort())
      expect(output).toHaveLength(input.length)
    }
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('shuffle actually reorders at least sometimes', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const rng = createRng('reorder')
    const orders = new Set(Array.from({ length: 50 }, () => rng.shuffle(input).join('')))
    expect(orders.size).toBeGreaterThan(5)
  })

  it('sample never repeats an element and rejects impossible requests', () => {
    const rng = createRng('sample')
    const pool = Array.from({ length: 10 }, (_, index) => `item-${index}`)
    const picked = rng.sample(pool, 4)
    expect(picked).toHaveLength(4)
    expect(new Set(picked).size).toBe(4)
    expect(() => rng.sample(pool, 11)).toThrow(RangeError)
    expect(() => rng.sample(pool, -1)).toThrow(RangeError)
    expect(rng.sample(pool, 0)).toEqual([])
  })

  it('pick refuses an empty pool', () => {
    expect(() => createRng('pick').pick([])).toThrow(RangeError)
    expect(createRng('pick').pick(['only'])).toBe('only')
  })
})
