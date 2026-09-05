import { describe, expect, it, vi } from 'vitest'
import type { BarService, GetBarsOpts, OhlcvBar } from '@/domain/market-data/bars/index.js'
import { analyzeTechnicalAnalysis } from './context.js'
import { buildTechnicalAnalysisIndicators } from './indicators.js'
import { loadIntrabarWindow } from './order-flow/intrabar-window.js'
import { analyzePriceActionBars } from './price-action/analyze.js'

function minuteBars(): OhlcvBar[] {
  return Array.from({ length: 300 }, (_, i) => {
    const price = i < 100 ? 100 : 200
    return {
      date: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      open: price, high: price, low: price, close: price, volume: 1,
    }
  })
}

function meta(bars: OhlcvBar[]) {
  return { symbol: 'TEST', from: bars[0]?.date ?? '', to: bars.at(-1)?.date ?? '', bars: bars.length, supportedIntervals: ['1m'] }
}

describe('technical-analysis review regressions', () => {
  it.each([1, -1])('does not erase confirmed extreme breaks when later pivots arrive (direction %s)', (direction) => {
    const highs = [102, 104, 110, 108, 107, 115, 120, 117, 116]
    const bars = highs.map((high, i) => {
      const bar = { date: `2026-08-${String(i + 1).padStart(2, '0')}`, open: 95 + i, high, low: 90 + i, close: i === 5 ? 112 : 95 + i, volume: 100 }
      return direction === 1 ? bar : { ...bar, open: 250 - bar.open, close: 250 - bar.close, high: 250 - bar.low, low: 250 - bar.high }
    })
    const analyze = (count: number) => analyzePriceActionBars({
      bars: bars.slice(0, count), interval: '1d',
      options: { marketStructureMode: 'extreme', internalLookback: 2, swingLookback: 2, externalLookback: 2 },
    }).marketStructure
    const before = analyze(6)
    const after = analyze(9)
    expect(before.bos).toHaveLength(3)
    expect(after.bos).toEqual(before.bos)
    expect(after.stateByLevel.internal.trend).toBe(direction === 1 ? 'bullish' : 'bearish')
    expect(after.choch).toEqual([])
  })

  it.each(['inclusive', 'midnight'] as const)('loads the complete final week with %s end semantics', async (semantics) => {
    const start = Date.UTC(2026, 7, 24)
    const intrabars = Array.from({ length: 192 }, (_, i) => ({
      date: new Date(start + i * 3_600_000).toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 1,
    }))
    const getBars = vi.fn<BarService['getBars']>(async (_ref, opts) => {
      const upper = Date.parse(opts.end!) + (semantics === 'inclusive' ? 86_400_000 : 0)
      const bars = intrabars.filter((bar) => Date.parse(bar.date) < upper)
      return { bars, meta: meta(bars) }
    })
    const result = await loadIntrabarWindow({
      barService: { getBars, searchBarSources: vi.fn() }, ref: { barId: 'test|TEST' }, targetInterval: '1w', requestedCount: 1,
      targetBars: [{ ...intrabars[0]!, date: '2026-08-24', volume: 168 }],
      targetMeta: { ...meta(intrabars), supportedIntervals: ['1h', '1w'] },
    })
    expect(getBars).toHaveBeenCalledWith({ barId: 'test|TEST' }, { interval: '1h', start: '2026-08-24', end: '2026-08-31' })
    expect(result.intrabars).toHaveLength(168)
    expect(result.intrabars.at(-1)?.date).toBe('2026-08-30T23:00:00.000Z')
  })

  it('uses complete loaded VWAP history independently of the requested display count', async () => {
    const history = minuteBars()
    const service: BarService = {
      searchBarSources: vi.fn(),
      getBars: vi.fn(async (_ref, opts: GetBarsOpts) => {
        const bars = history.slice(-(opts.count ?? history.length))
        return { bars, meta: meta(bars) }
      }),
    }
    for (const count of [200, 300]) {
      const result = await analyzeTechnicalAnalysis(service, {
        barId: 'test|TEST', interval: '1m', count,
        indicators: { atrPeriod: 300, vwapAnchor: 'session' },
      })
      expect(result.status).toBe('ok')
      expect(result.intervals[0]?.indicators?.vwap).toMatchObject({ value: 166.666667, anchor: 'session', relation: 'above' })
      expect(result.intervals[0]?.meta?.bars).toBe(count)
    }
  })

  it.each(['session', 'week', 'month', 'year'] as const)('withholds incomplete %s VWAP instead of emitting a window average', (vwapAnchor) => {
    const bars = minuteBars().slice(-200)
    const structure = analyzePriceActionBars({ bars, interval: '1m' }).marketStructure
    const result = buildTechnicalAnalysisIndicators(bars, structure, { vwapAnchor })
    expect(result.vwap?.relation).toBe('unavailable')
    expect(result.vwap?.value).toBeUndefined()
    expect(result.vwap?.anchors?.[vwapAnchor]).toBeUndefined()
    expect(result.vwap?.incompleteAnchors).toContain(vwapAnchor)
    expect(result.confluenceZones).toEqual([])
    expect(result.warnings.some((warning) => warning.includes('does not reach their boundary'))).toBe(true)
  })

  it('returns exactly filled FVGs only when includeFilled is enabled', () => {
    const bars = [[99, 100, 98, 99], [100, 110, 100, 109], [112, 114, 111, 113], [110, 112, 100, 100]]
      .map(([open, high, low, close], i) => ({ date: `2026-08-0${i + 1}`, open, high, low, close, volume: 100 }))
    const analyze = (includeFilled: boolean) => analyzePriceActionBars({
      bars, interval: '1d', options: { includeFilled, overlapPolicy: 'none' },
    })
    expect(analyze(false).fvgs).toEqual([])
    expect(analyze(true).fvgs).toEqual([expect.objectContaining({ state: 'filled', completelyFilled: true, filledAtIndex: 3 })])
    expect(analyze(true).breakers).toEqual([])
  })
})
