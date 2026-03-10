import { describe, it, expect } from 'vitest'
import type { OhlcvData } from '@/extension/indicator-kit/index'
import { analyzeBrooksPa } from '../analyzer'

describe('analyzeBrooksPa', () => {
  it('enforces recentBars length and midpoint no-trade', () => {
    const bars: OhlcvData[] = Array.from({ length: 300 }, (_, i) => ({
      date: `2026-01-01T${String(i).padStart(2, '0')}:00:00Z`,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1,
    }))

    const out = analyzeBrooksPa({
      symbol: 'TEST',
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      lookbackBars: 300,
      recentBars: 10,
      midpointAvoidance: { enabled: true, band: 0.4 },
      dataByTf: { '5m': bars, '15m': bars, '1h': bars },
    })

    expect(out.recentBars).toHaveLength(10)
    expect(out.noTrade.length).toBeGreaterThan(0)
    expect(out.noTrade[0].code).toBe('TR_MIDPOINT')
  })
})
