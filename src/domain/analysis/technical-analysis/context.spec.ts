/**
 * Top-level multi-interval summary — the bias/alignment roll-up the agent reads
 * before it looks at any single interval.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BarService, BarsResult, OhlcvBar } from '@/domain/market-data/bars/index.js'
import { analyzeTechnicalAnalysis } from './context.js'

/** Flat series: no swings, so no level confirms a BOS/CHoCH → every trend 'unknown'. */
function flatBars(count: number): OhlcvBar[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2024-01-01 09:${String(index).padStart(2, '0')}:00`,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1000,
  }))
}

function serviceFor(bars: OhlcvBar[]): BarService {
  return {
    searchBarSources: vi.fn(),
    getBars: vi.fn(async () => ({
      bars,
      meta: {
        symbol: 'AAPL',
        from: bars[0]?.date ?? '',
        to: bars[bars.length - 1]?.date ?? '',
        bars: bars.length,
        barId: 'tradingview|AAPL',
        supportedIntervals: ['15m'],
      },
    } as BarsResult)),
  } as unknown as BarService
}

describe('analyzeTechnicalAnalysis — summary bias', () => {
  it("reports 'unknown', not 'mixed', when no interval has a confirmed trend", async () => {
    const result = await analyzeTechnicalAnalysis(serviceFor(flatBars(40)), {
      barId: 'tradingview|AAPL',
      interval: '15m',
      count: 40,
    })

    expect(result.intervals[0]!.summary!.trend).toBe('unknown')
    // 0 bullish vs 0 bearish means "no structure yet", not "the timeframes conflict".
    expect(result.summary.bias).toBe('unknown')
  })

  it("keeps bias and alignment consistent across several structureless intervals", async () => {
    const result = await analyzeTechnicalAnalysis(serviceFor(flatBars(40)), {
      barId: 'tradingview|AAPL',
      intervals: ['15m', '1h'],
      count: 40,
    })

    expect(result.intervals).toHaveLength(2)
    expect(result.summary.bias).toBe('unknown')
    // 'mixed' here would contradict the 'unknown' bias in the same payload.
    expect(result.summary.alignment).toBe('unknown')
    expect(result.summary.conflicts).toEqual([])
  })
})
