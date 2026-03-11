import { describe, expect, it } from 'vitest'
import type { OhlcvData } from '@/extension/indicator-kit/index'
import {
  analyzeBrooksPa,
  buildBrooksFrames,
  buildBrooksLevels,
  detectBrooksStructure,
  loadBrooksContext,
  summarizeBrooksDecisionWindow,
} from '../analyzer'

function makeBars(values: Array<{ open: number; high: number; low: number; close: number }>): OhlcvData[] {
  const start = new Date('2026-01-01T00:00:00.000Z').getTime()
  return values.map((value, index) => ({
    date: new Date(start + index * 5 * 60 * 1000).toISOString(),
    volume: 1,
    ...value,
  }))
}

describe('Brooks analyzer split functions', () => {
  it('builds frames and summarizes the execution decision window', () => {
    const bars = makeBars([
      { open: 100, high: 101, low: 99, close: 100.5 },
      { open: 100.5, high: 102, low: 100, close: 101.8 },
      { open: 101.8, high: 103, low: 101, close: 102.7 },
      { open: 102.7, high: 104, low: 102.5, close: 103.6 },
      { open: 103.6, high: 105.5, low: 103.2, close: 105.2 },
    ])
    const context = loadBrooksContext({
      symbol: 'TEST',
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      lookbackBars: 300,
      recentBars: 3,
      midpointAvoidance: { enabled: false, band: 0.4 },
      dataByTf: { '1h': bars, '15m': bars, '5m': bars },
    })

    const frames = buildBrooksFrames(context)
    const decisionWindow = summarizeBrooksDecisionWindow({ tf: '5m', bars, recentBars: 3 })

    expect(frames['5m'].bars).toHaveLength(3)
    expect(frames['5m'].latestClose).toBe(105.2)
    expect(decisionWindow.summary.barCount).toBe(3)
    expect(decisionWindow.summary.dominantSide).toBe('bull')
  })

  it('detects breakout-style Brooks structure and preserves aggregate compatibility', () => {
    const bars = makeBars([
      { open: 100, high: 101, low: 99, close: 100.4 },
      { open: 100.4, high: 101.3, low: 100.1, close: 100.9 },
      { open: 100.9, high: 101.6, low: 100.7, close: 101.1 },
      { open: 101.1, high: 101.8, low: 100.8, close: 101.2 },
      { open: 101.2, high: 102, low: 100.9, close: 101.5 },
      { open: 101.5, high: 103.4, low: 101.3, close: 103.2 },
      { open: 103.2, high: 104.2, low: 103, close: 104 },
    ])

    const structure = detectBrooksStructure({
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      dataByTf: { '1h': bars, '15m': bars, '5m': bars },
    })
    const levels = buildBrooksLevels({
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      dataByTf: { '1h': bars, '15m': bars, '5m': bars },
    })
    const out = analyzeBrooksPa({
      symbol: 'TEST',
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      lookbackBars: 300,
      recentBars: 4,
      midpointAvoidance: { enabled: false, band: 0.4 },
      dataByTf: { '1h': bars, '15m': bars, '5m': bars },
    })

    expect(structure['5m'].marketType).toBe('breakout')
    expect(levels.levels.length).toBeGreaterThan(0)
    expect(out.recentBars).toHaveLength(4)
    expect(out.decisionWindow.bars).toHaveLength(4)
    expect(out.marketTypeByTf['5m'].marketType).toBe('breakout')
  })

  it('enforces midpoint no-trade on the aggregate output', () => {
    const bars = makeBars(Array.from({ length: 20 }, () => ({ open: 100, high: 110, low: 90, close: 100 })))
    const out = analyzeBrooksPa({
      symbol: 'TEST',
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      lookbackBars: 300,
      recentBars: 10,
      midpointAvoidance: { enabled: true, band: 0.4 },
      dataByTf: { '1h': bars, '15m': bars, '5m': bars },
    })

    expect(out.noTrade[0].code).toBe('TR_MIDPOINT')
  })
})
