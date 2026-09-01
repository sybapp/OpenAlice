import { describe, expect, it } from 'vitest'
import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import type { MarketStructureAnalysis } from '@/domain/analysis/technical-analysis/price-action/types.js'
import { buildTechnicalAnalysisIndicators } from './indicators.js'

function bars(closes: number[], volume: number | null = 100): OhlcvBar[] {
  return closes.map((close, index) => ({
    date: `2024-01-${String(index + 1).padStart(2, '0')}`,
    open: close - 0.25,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  }))
}

function structure(): MarketStructureAnalysis {
  const brokenSwing = { index: 8, price: 108, type: 'high' as const }
  return {
    marketStructureMode: 'pivot',
    swingPoints: {
      internal: { highs: [brokenSwing], lows: [{ index: 3, price: 101, type: 'low' }] },
      swing: { highs: [brokenSwing], lows: [{ index: 3, price: 101, type: 'low' }] },
      external: { highs: [], lows: [] },
    },
    stateByLevel: {
      internal: { trend: 'bullish', trendValue: 1 },
      swing: { trend: 'bullish', trendValue: 1 },
      external: { trend: 'unknown', trendValue: 0 },
    },
    bos: [{ type: 'bullish', index: 10, price: 111, level: 'swing', brokenSwing }],
    choch: [],
    swingStrength: [],
  }
}

describe('unified technical-analysis indicators', () => {
  it('derives EMA, anchored VWAP, and a structure-leg Fibonacci retracement', () => {
    const result = buildTechnicalAnalysisIndicators(
      bars([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 111, 112]),
      structure(),
      {
        emaFastPeriod: 3,
        emaSlowPeriod: 5,
        emaLongPeriod: 8,
        vwapAnchor: 'rolling',
        volumeLookback: 4,
        fibLevels: [0.5],
        confluenceMinFamilies: 2,
      },
    )

    expect(result.ema).toMatchObject({ bias: 'bullish' })
    expect(result.ema.fast).toBeGreaterThan(110)
    expect(result.vwap).toMatchObject({ anchor: 'rolling', relation: 'above' })
    expect(result.fibRetracements).toHaveLength(1)
    expect(result.fibRetracements[0]).toMatchObject({
      direction: 'bullish',
      startIndex: 3,
      endIndex: 10,
      status: 'active',
    })
    expect(result.fibRetracements[0]!.levels[0]).toMatchObject({ ratio: 0.5, touched: false, crossed: false })
  })

  it('reports missing volume instead of inventing VWAP evidence', () => {
    const result = buildTechnicalAnalysisIndicators(
      bars([100, 101, 100.5, 102], null),
      structure(),
      { vwapEnabled: true },
    )

    expect(result.vwap?.relation).toBe('unavailable')
    expect(result.warnings).toContain('VWAP unavailable because the requested bars contain no positive volume')
  })
})
