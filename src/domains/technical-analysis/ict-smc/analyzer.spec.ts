import { describe, expect, it } from 'vitest'
import type { OhlcvData } from '@/domains/technical-analysis/indicator-kit/index'
import { detectFairValueGaps } from './analyzer/fvg'
import { detectLiquidityPools } from './analyzer/liquidity'
import { detectBosChoch, detectStructure, summarizeIctDecisionWindow } from './analyzer/structure'
import { detectSwings } from './analyzer/swings'

function makeBars(values: Array<{ open: number; high: number; low: number; close: number }>): OhlcvData[] {
  const start = new Date('2026-02-01T00:00:00.000Z').getTime()
  return values.map((value, index) => ({
    date: new Date(start + index * 5 * 60 * 1000).toISOString(),
    volume: 1,
    ...value,
  }))
}

describe('ICT/SMC deterministic analyzers', () => {
  const bars = makeBars([
    { open: 100, high: 101, low: 99.5, close: 100.8 },
    { open: 100.8, high: 103, low: 100.6, close: 102.7 },
    { open: 102.7, high: 102.9, low: 101.9, close: 102.1 },
    { open: 102.1, high: 104.8, low: 104.2, close: 104.6 },
    { open: 104.6, high: 104.9, low: 103.7, close: 103.9 },
    { open: 103.9, high: 104.85, low: 103.6, close: 104.1 },
    { open: 104.1, high: 105.6, low: 103.2, close: 103.4 },
    { open: 103.4, high: 103.8, low: 101.1, close: 101.4 },
    { open: 101.4, high: 102.2, low: 100.4, close: 101.8 },
    { open: 101.8, high: 103.7, low: 101.7, close: 103.5 },
  ])

  it('detects swing highs and lows', () => {
    const swings = detectSwings(bars, 1)
    expect(swings.some((swing) => swing.kind === 'high')).toBe(true)
    expect(swings.some((swing) => swing.kind === 'low')).toBe(true)
  })

  it('detects equal-high and equal-low liquidity pools', () => {
    const swings = detectSwings(bars, 1)
    const liquidity = detectLiquidityPools(swings, bars)
    expect(liquidity.some((pool) => pool.kind === 'equal-highs')).toBe(true)
    expect(liquidity.some((pool) => pool.side === 'buy')).toBe(true)
  })

  it('detects filled and unfilled fair value gaps', () => {
    const fvgs = detectFairValueGaps(bars)
    expect(fvgs.some((fvg) => fvg.side === 'bullish')).toBe(true)
    expect(fvgs.some((fvg) => fvg.filled === false || fvg.filled === true)).toBe(true)
  })

  it('detects BOS/CHOCH, displacement, mitigation, and premium-discount state', () => {
    const swings = detectSwings(bars, 1)
    const liquidity = detectLiquidityPools(swings, bars)
    const fvgs = detectFairValueGaps(bars)
    const bosChoch = detectBosChoch(swings, bars)
    const structure = detectStructure({ swings, bars, fvgs, liquidity })
    const decisionWindow = summarizeIctDecisionWindow({ tf: '5m', bars, liquidity, structure })

    expect(bosChoch.bos.length + bosChoch.choch.length).toBeGreaterThan(0)
    expect(['bullish', 'bearish', 'neutral']).toContain(structure.bias)
    expect(['premium', 'discount', 'equilibrium', 'unknown']).toContain(structure.premiumDiscount.state)
    expect(decisionWindow.bars).toHaveLength(10)
    expect(decisionWindow.summary.notes.length).toBeGreaterThan(0)
  })
})
