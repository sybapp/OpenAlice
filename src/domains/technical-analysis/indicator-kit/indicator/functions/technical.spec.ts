import { describe, it, expect } from 'vitest'
import { RSI } from './technical.js'

describe('RSI edge cases', () => {
  it('returns 50 for flat data (no gains, no losses)', () => {
    // 16 identical values → all changes are 0
    const flat = Array(16).fill(100)
    expect(RSI(flat, 14)).toBe(50)
  })

  it('returns 100 for purely rising data', () => {
    const rising = Array.from({ length: 16 }, (_, i) => 100 + i)
    expect(RSI(rising, 14)).toBe(100)
  })

  it('returns approximately 0 for purely falling data', () => {
    const falling = Array.from({ length: 16 }, (_, i) => 200 - i)
    const rsi = RSI(falling, 14)
    expect(rsi).toBeCloseTo(0, 5)
  })

  it('returns a value between 0 and 100 for mixed data', () => {
    const mixed = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00]
    const rsi = RSI(mixed, 14)
    expect(rsi).toBeGreaterThan(0)
    expect(rsi).toBeLessThan(100)
  })
})
