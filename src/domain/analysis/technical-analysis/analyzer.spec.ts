import { describe, expect, it } from 'vitest'
import { TechnicalAnalysisAnalyzer } from './analyzer.js'
import type { TechnicalAnalysisCandle } from './types.js'

function c(index: number, open: number, high: number, low: number, close: number, volume = 1000): TechnicalAnalysisCandle {
  return { time: index, open, high, low, close, volume }
}

const structureCandles: TechnicalAnalysisCandle[] = [
  c(0, 10, 11, 9, 10, 1000),
  c(1, 11, 13, 10, 12, 1050),
  c(2, 12, 15, 11, 14, 1100),
  c(3, 14, 16, 12, 13, 1200),
  c(4, 13, 14, 10, 11, 1000),
  c(5, 11, 12, 8, 9, 950),
  c(6, 9, 10, 7, 8, 900),
  c(7, 8, 9, 5, 7, 900),
  c(8, 7, 9, 6, 8, 900),
  c(9, 8, 12, 7, 11, 1600),
  c(10, 11, 17, 10, 17, 2500),
  c(11, 17, 18, 15, 16, 1300),
  c(12, 16, 17, 14, 15, 1200),
  c(13, 15, 16, 13, 14, 1100),
  c(14, 14, 15, 12, 13, 1000),
  c(15, 13, 14, 11, 12, 1000),
  c(16, 12, 13, 10, 11, 1100),
  c(17, 11, 12, 9, 10, 1200),
  c(18, 10, 11, 7, 8, 2300),
  c(19, 8, 9, 5, 6, 2400),
  c(20, 6, 8, 3, 4, 2600),
  c(21, 4, 5, 2, 3, 1800),
  c(22, 3, 4, 2, 3, 1600),
]

describe('TechnicalAnalysisAnalyzer', () => {
  it('detects pivots, MSS/BOS structure events, order blocks, and volume confirmations', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(structureCandles, {
      internalLookback: 2,
      swingLookback: 3,
      volumeLookback: 4,
      maxOrderBlocks: 10,
    })

    expect(analysis.pivots.some((pivot) => pivot.kind === 'high' && pivot.index === 3)).toBe(true)
    expect(analysis.pivots.some((pivot) => pivot.kind === 'low' && pivot.index === 7)).toBe(true)
    expect(analysis.structureEvents.some((event) => event.type === 'MSS' && event.direction === 'bullish')).toBe(true)
    expect(analysis.structureEvents.some((event) => event.direction === 'bearish')).toBe(true)
    expect(analysis.orderBlocks.length).toBeGreaterThan(0)
    expect(analysis.orderBlocks.every((block) => block.sourceStructureId)).toBe(true)
    expect(analysis.orderBlocks.some((block) => block.relativeVolumeShare !== undefined)).toBe(true)
    expect(analysis.volumePriceSignals.some((signal) => signal.kind === 'breakout_confirmation')).toBe(true)
  })

  it('does not use pivots before their lookback confirmation window closes', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 9, 10, 7, 9),
      c(1, 10, 12, 8, 11),
      c(2, 12, 16, 11, 15),
      c(3, 15, 14, 10, 12),
      c(4, 12, 13, 9, 11),
      c(5, 11, 12, 8, 10),
      c(6, 10, 11, 7, 9),
      c(7, 9, 12, 8, 11),
      c(8, 11, 17, 10, 17),
      c(9, 17, 18, 16, 17),
    ], {
      internalLookback: 2,
      swingLookback: 50,
      useCloseBreak: false,
    })

    const firstBullishBreak = analysis.structureEvents.find((event) =>
      event.direction === 'bullish' && event.brokenPivot.index === 2,
    )

    expect(analysis.pivots).toContainEqual(expect.objectContaining({ index: 2, kind: 'high' }))
    expect(firstBullishBreak?.index).toBe(8)
  })

  it('keeps swing trend separate from newer internal structure events', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(structureCandles, {
      internalLookback: 2,
      swingLookback: 3,
      volumeLookback: 4,
      maxOrderBlocks: 10,
    })

    const latestInternal = analysis.structureEvents.filter((event) => event.level === 'internal').at(-1)
    const latestSwing = analysis.structureEvents.filter((event) => event.level === 'swing').at(-1)

    expect(latestInternal).toBeDefined()
    expect(latestSwing).toBeDefined()
    expect(analysis.summary.internalTrend).toBe(latestInternal?.direction)
    expect(analysis.summary.swingTrend).toBe(latestSwing?.direction)
    expect(analysis.summary.trend).toBe(analysis.summary.swingTrend)
  })

  it('detects FVG from price structure without requiring volume', () => {
    const candles = [
      { time: 0, open: 10, high: 11, low: 9, close: 10, volume: null },
      { time: 1, open: 10, high: 12, low: 10, close: 11, volume: null },
      { time: 2, open: 13, high: 15, low: 13, close: 14, volume: null },
      { time: 3, open: 14, high: 14.5, low: 10.5, close: 10.8, volume: null },
    ]

    const analysis = new TechnicalAnalysisAnalyzer().analyze(candles, {
      internalLookback: 2,
      swingLookback: 2,
    })

    expect(analysis.fairValueGaps).toHaveLength(1)
    expect(analysis.fairValueGaps[0]).toMatchObject({
      direction: 'bullish',
      bottom: 11,
      top: 13,
      filled: true,
      volumeConfirmation: 'unavailable',
    })
    expect(analysis.warnings).toContain('Volume is unavailable; volume-price confirmations are omitted.')
  })

  it('detects liquidity zones from clustered swing highs/lows', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 9, 10, 8.5, 9.5),
      c(1, 9.5, 11, 9, 10.5),
      c(2, 10.5, 12, 10, 11.5),
      c(3, 11.5, 13, 10.5, 12.2),
      c(4, 12.2, 12, 10, 10.5),
      c(5, 10.5, 11, 9.5, 10),
      c(6, 10, 12, 9.8, 11.2),
      c(7, 11.2, 13.1, 10.6, 12.1),
      c(8, 12.1, 12, 10.2, 10.7),
      c(9, 10.7, 11, 9.5, 10),
      c(10, 10, 10.8, 9.2, 9.6),
      c(11, 9.6, 10.2, 8.9, 9.2),
    ], {
      internalLookback: 2,
      swingLookback: 2,
      liquidity: {
        enabled: true,
        atrMargin: 2.5,
        minClusterSize: 2,
        maxVisible: 5,
      },
    })

    expect(analysis.liquidityZones.length).toBeGreaterThan(0)
    expect(analysis.relevance.liquidityZones.length).toBeGreaterThan(0)
  })

  it('marks liquidity zones swept when wicks pierce and close back inside', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 9, 10, 8.5, 9.5),
      c(1, 9.5, 11, 9, 10.5),
      c(2, 10.5, 12, 10, 11.5),
      c(3, 11.5, 13, 10.5, 12.2),
      c(4, 12.2, 12, 10, 10.5),
      c(5, 10.5, 11, 9.5, 10),
      c(6, 10, 12, 9.8, 11.2),
      c(7, 11.2, 13.1, 10.6, 12.1),
      c(8, 12.1, 12, 10.2, 10.7),
      c(9, 10.7, 12.4, 9.5, 12.2),
      c(10, 12.2, 13.6, 9.2, 12.2),
      c(11, 9.6, 10.2, 8.9, 9.2),
    ], {
      internalLookback: 2,
      swingLookback: 2,
      liquidity: {
        enabled: true,
        atrMargin: 2.5,
        minClusterSize: 2,
        maxVisible: 5,
      },
    })

    expect(analysis.liquidityZones.some((zone) => zone.side === 'buyside' && zone.status === 'swept')).toBe(true)
  })

  it('detects balance price ranges from overlapping bull/bear FVGs', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 9.5, 10, 9, 9.8),
      c(1, 9.9, 11, 9.7, 10.8),
      c(2, 12.2, 13, 12, 12.8),
      c(3, 11.8, 12.5, 11.5, 12),
      c(4, 9.2, 9.5, 8.5, 9),
      c(5, 9.1, 9.6, 8.7, 9.3),
    ], {
      internalLookback: 1,
      swingLookback: 1,
      bpr: { enabled: true, maxVisible: 5 },
      zoneFilter: { includeFilledFairValueGaps: true },
    })

    expect(analysis.balancePriceRanges.length).toBeGreaterThan(0)
    expect(analysis.relevance.balancePriceRanges.length).toBeGreaterThan(0)
  })

  it('keeps raw structures and exposes a filtered relevance view', () => {
    const candles = [
      c(0, 100, 101, 99, 100),
      c(1, 100, 101, 99, 100),
      c(2, 101.01, 101.2, 101.01, 101.1),
      c(3, 101.15, 101.3, 100.5, 100.7),
      c(4, 102.2, 102.5, 102.2, 102.4),
      c(5, 103.4, 103.8, 103.4, 103.6),
      c(6, 104.6, 105, 104.6, 104.8),
      c(7, 105.7, 106, 105.7, 105.9),
      c(8, 106.8, 107, 106.8, 106.9),
      c(9, 107.9, 108.1, 107.9, 108),
    ]

    const analysis = new TechnicalAnalysisAnalyzer().analyze(candles, {
      internalLookback: 2,
      swingLookback: 2,
      atrPeriod: 3,
      zoneFilter: {
        maxAgeBars: 3,
        maxDistanceAtr: 2,
        minGapAtr: 0.5,
        minGapPercent: 0.005,
        maxZones: 3,
        mergeOverlappingZones: true,
      },
    })

    expect(analysis.fairValueGaps.length).toBeGreaterThan(analysis.relevance.fairValueGaps.length)
    expect(analysis.relevance.fairValueGaps.length).toBeLessThanOrEqual(3)
    expect(analysis.relevance.filteredSummary.fairValueGaps.raw).toBe(analysis.fairValueGaps.length)
    expect(analysis.relevance.filteredSummary.fairValueGaps.reasons.too_old).toBeGreaterThan(0)
    expect(analysis.relevance.filteredSummary.fairValueGaps.reasons.filled).toBeGreaterThan(0)
    expect(analysis.relevance.filteredSummary.fairValueGaps.reasons.merged_or_limited).toBeGreaterThan(0)
    expect(analysis.relevance.zones.length).toBeLessThanOrEqual(3)
  })

  it('can disable relevance filtering for replay/debug output', () => {
    const candles = [
      c(0, 10, 11, 9, 10),
      c(1, 10, 12, 10, 11),
      c(2, 13, 15, 13, 14),
      c(3, 14, 14.5, 10.5, 10.8),
    ]

    const analysis = new TechnicalAnalysisAnalyzer().analyze(candles, {
      internalLookback: 2,
      swingLookback: 2,
      zoneFilter: {
        enabled: false,
        maxZones: 20,
      },
    })

    expect(analysis.fairValueGaps).toHaveLength(1)
    expect(analysis.fairValueGaps[0].filled).toBe(true)
    expect(analysis.relevance.fairValueGaps).toHaveLength(1)
    expect(analysis.relevance.fairValueGaps[0].filled).toBe(true)
    expect(analysis.relevance.filteredSummary.fairValueGaps.reasons).toEqual({})
  })

  it('filters tiny fair value gaps from relevance', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 100, 101, 99, 100),
      c(1, 100, 101, 99, 100),
      c(2, 101.01, 101.2, 101.01, 101.1),
    ], {
      internalLookback: 2,
      swingLookback: 2,
      zoneFilter: {
        includeFilledFairValueGaps: true,
        minGapAtr: 0.5,
        minGapPercent: 0.005,
      },
    })

    expect(analysis.fairValueGaps).toHaveLength(1)
    expect(analysis.relevance.fairValueGaps).toHaveLength(0)
    expect(analysis.relevance.filteredSummary.fairValueGaps.reasons.too_small).toBe(1)
  })

  it('filters touched but unfilled fair value gaps from relevance by default', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 10, 11, 10, 10.5),
      c(1, 10.5, 12, 10.5, 11.8),
      c(2, 13, 14, 13, 13.5),
      c(3, 13.5, 13.8, 11.5, 13.2),
    ], {
      internalLookback: 1,
      swingLookback: 1,
    })

    expect(analysis.fairValueGaps[0]).toMatchObject({ status: 'broken', filled: false })
    expect(analysis.relevance.fairValueGaps.some((gap) => gap.id === analysis.fairValueGaps[0].id)).toBe(false)
    expect(analysis.relevance.filteredSummary.fairValueGaps.reasons.broken).toBe(1)
  })

  it('anchors OG and VI gaps to the adjacent left candle', () => {
    const og = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 10, 10.5, 9, 10),
      c(1, 10, 11, 9.5, 10.5),
      c(2, 12, 13, 12, 12.5),
    ], {
      fvgMode: 'OG',
      internalLookback: 2,
      swingLookback: 2,
    })

    const vi = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 10, 10.5, 9, 10),
      c(1, 10, 11.8, 9.5, 10.5),
      c(2, 12, 13, 11.2, 12.5),
    ], {
      fvgMode: 'VI',
      internalLookback: 2,
      swingLookback: 2,
    })

    expect(og.fairValueGaps[0]).toMatchObject({ mode: 'OG', leftIndex: 1, leftTime: 1 })
    expect(vi.fairValueGaps[0]).toMatchObject({ mode: 'VI', leftIndex: 1, leftTime: 1 })
  })

  it('detects IFVG inversions from prior FVG breaks', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 9.5, 10, 9, 9.5, 100),
      c(1, 10, 11, 9.8, 10.5, 110),
      c(2, 12.2, 13, 12, 12.5, 120),
      c(3, 11, 11.2, 9.2, 9.4, 240),
      c(4, 9.4, 10.5, 9, 10.2, 130),
    ], {
      fvgMode: 'IFVG',
      internalLookback: 1,
      swingLookback: 1,
      volumeLookback: 3,
    })

    expect(analysis.fairValueGaps.length).toBeGreaterThan(0)
    expect(analysis.fairValueGaps[0].mode).toBe('IFVG')
    expect(analysis.volumePriceSignals.some((signal) => signal.kind === 'ifvg_inversion')).toBe(true)
  })

  it('detects equal highs/lows with ATR tolerance', () => {
    const candles = [
      c(0, 10, 11, 9, 10),
      c(1, 10, 15, 9, 14),
      c(2, 14, 13, 8, 9),
      c(3, 9, 14.95, 8.5, 12),
      c(4, 12, 12, 7, 8),
      c(5, 8, 12.5, 7.05, 11),
      c(6, 11, 10, 8, 9),
      c(7, 9, 11, 7.02, 10),
      c(8, 10, 10.5, 8.4, 9),
    ]

    const analysis = new TechnicalAnalysisAnalyzer().analyze(candles, {
      internalLookback: 2,
      swingLookback: 2,
      atrPeriod: 3,
      equalToleranceAtr: 0.2,
    })

    expect(analysis.equalHighLows.some((entry) => entry.kind === 'EQH')).toBe(true)
    expect(analysis.equalHighLows.some((entry) => entry.kind === 'EQL')).toBe(true)
  })

  it('detects accumulation/distribution zones and premium/discount range', () => {
    const candles = [
      c(0, 10, 11, 10, 10.5),
      c(1, 10.5, 14, 10, 13),
      c(2, 13, 13, 7, 8),
      c(3, 8, 15, 8, 14),
      c(4, 14, 14, 9, 10),
      c(5, 10, 13, 10, 12),
      c(6, 12, 12, 8, 9),
      c(7, 9, 14, 9, 13),
      c(8, 13, 13, 10, 11),
      c(9, 11, 13.5, 11, 13),
      c(10, 13, 13, 9, 10),
      c(11, 10, 12, 10, 11),
      c(12, 11, 12, 10.5, 11.5),
    ]

    const analysis = new TechnicalAnalysisAnalyzer().analyze(candles, {
      internalLookback: 1,
      swingLookback: 1,
      zoneMode: 'Fast',
    })

    expect(analysis.accumulationDistributionZones.length).toBeGreaterThan(0)
    expect(analysis.premiumDiscount).toBeDefined()
    expect(analysis.strongWeakLevels).toHaveLength(2)
  })

  it('adds EMA/VWAP confluence to summary and volume signals', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(structureCandles, {
      internalLookback: 2,
      swingLookback: 3,
      volumeLookback: 4,
      emaFastPeriod: 12,
      emaSlowPeriod: 20,
      emaLongPeriod: 50,
      vwapAnchor: 'auto',
    })

    expect(analysis.summary.confluence).toBeDefined()
    expect(analysis.summary.confluence?.emaBias).toMatch(/bullish|bearish|mixed|unavailable/)
    const breakout = analysis.volumePriceSignals.find((signal) => signal.kind === 'breakout_confirmation' || signal.kind === 'weak_breakout')
    expect(breakout?.confluence).toBeDefined()
    expect(breakout?.confluence?.vwapAnchor).toBe('structure')
    expect(typeof breakout?.confluenceScore).toBe('number')
  })

  it('supports explicit rolling VWAP anchor mode', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(structureCandles, {
      internalLookback: 2,
      swingLookback: 3,
      volumeLookback: 4,
      vwapAnchor: 'rolling',
    })

    const signal = analysis.volumePriceSignals.find((entry) => entry.confluence?.vwap !== undefined)
    expect(signal?.confluence?.vwapAnchor).toBe('rolling')
  })

  it('supports explicit weekly VWAP anchor mode', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      { time: '2026-05-04', open: 10, high: 11, low: 9.9, close: 10.8, volume: 1000 },
      { time: '2026-05-05', open: 10.8, high: 11.2, low: 10.5, close: 11, volume: 1100 },
      { time: '2026-05-06', open: 11, high: 11.4, low: 10.8, close: 11.2, volume: 1200 },
      { time: '2026-05-07', open: 11.2, high: 11.6, low: 10.9, close: 11.1, volume: 900 },
      { time: '2026-05-08', open: 11.1, high: 11.7, low: 11, close: 11.6, volume: 1500 },
    ], {
      internalLookback: 1,
      swingLookback: 1,
      vwapAnchor: 'week',
    })

    expect(analysis.summary.confluence?.vwapAnchor).toBe('week')
  })

  it('uses candle VWAP in confluence when provided even without volume', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      { time: '2026-05-07T14:30:00.000Z', open: 10, high: 11, low: 9, close: 10, volume: null, vwap: 9.9 },
      { time: '2026-05-07T14:35:00.000Z', open: 10, high: 12, low: 9.8, close: 11, volume: null, vwap: 10.1 },
      { time: '2026-05-07T14:40:00.000Z', open: 11, high: 12.5, low: 10.5, close: 12, volume: null, vwap: 10.8 },
    ], {
      internalLookback: 2,
      swingLookback: 2,
      vwapAnchor: 'session',
      vwapDeviation: { enabled: false },
    })

    expect(analysis.volumePriceSignals).toHaveLength(0)
    expect(analysis.summary.confluence?.vwap).toBe(10.8)
    expect(analysis.summary.confluence?.vwapAnchor).toBe('session')
  })

  it('builds fib retracement levels and confluence zones', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(structureCandles, {
      internalLookback: 2,
      swingLookback: 3,
      fib: {
        enabled: true,
        anchorMode: 'structure-leg',
        levels: [0.382, 0.5, 0.618, 0.786],
      },
      confluenceZone: {
        enabled: true,
        minFamilies: 2,
        overlapAtrMultiplier: 3,
        maxVisible: 10,
      },
    })

    expect(analysis.fibRetracements.length).toBeGreaterThan(0)
    expect(analysis.fibRetracements[0].levels.map((level) => level.ratio)).toEqual([0.382, 0.5, 0.618, 0.786])
    expect(analysis.confluenceZones.length).toBeGreaterThan(0)
    expect(analysis.relevance.confluenceZones.length).toBeGreaterThan(0)
  })

  it('calculates fib retracement prices from a known swing range', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 99, 100, 95, 98),
      c(1, 98, 101, 96, 100),
      c(2, 100, 105, 99, 104),
      c(3, 104, 103, 98, 100),
      c(4, 100, 102, 96, 98),
      c(5, 98, 103, 97, 102),
      c(6, 102, 106, 101, 106),
      c(7, 106, 110, 105, 109),
      c(8, 109, 108, 103, 105),
    ], {
      internalLookback: 2,
      swingLookback: 50,
      useCloseBreak: false,
      fib: {
        enabled: true,
        levels: [0.382, 0.5, 0.618, 0.786],
      },
      confluenceZone: { enabled: false },
    })

    const fib = analysis.fibRetracements[0]
    expect(fib).toMatchObject({ startPrice: 96, endPrice: 106, direction: 'bullish' })
    expect(fib.levels.map((level) => level.price)).toEqual([102.18, 101, 99.82, 98.14])
  })

  it('anchors fib retracements to the structure event instead of future candles', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 99, 100, 95, 98),
      c(1, 98, 101, 96, 100),
      c(2, 100, 105, 99, 104),
      c(3, 104, 103, 98, 100),
      c(4, 100, 102, 96, 98),
      c(5, 98, 103, 97, 102),
      c(6, 102, 106, 101, 106),
      c(7, 106, 110, 105, 109),
      c(8, 109, 108, 103, 105),
      c(9, 105, 120, 104, 119),
    ], {
      internalLookback: 2,
      swingLookback: 50,
      useCloseBreak: false,
      fib: {
        enabled: true,
        levels: [0.5],
      },
      confluenceZone: { enabled: false },
    })

    expect(analysis.fibRetracements[0]).toMatchObject({ startPrice: 96, endIndex: 6, endPrice: 106 })
    expect(analysis.fibRetracements[0].levels[0].price).toBe(101)
  })

  it('keeps VWAP equal to constant typical price with equal volume', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(
      Array.from({ length: 25 }, (_, index) => ({ time: index, open: 10, high: 11, low: 9, close: 10, volume: 100 })),
      { internalLookback: 2, swingLookback: 2, vwapDeviation: { enabled: false } },
    )

    expect(analysis.summary.confluence?.vwap).toBe(10)
    expect(analysis.summary.confluence?.vwapRelation).toBe('at')
  })

  it('places volume profile POC in the concentrated price bin', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze(
      Array.from({ length: 25 }, (_, index) => ({ time: index, open: 10, high: 11, low: 9, close: 10, volume: 100 })),
      {
        internalLookback: 2,
        swingLookback: 2,
        volumeProfile: { enabled: true, lookback: 20, bins: 20, smoothing: 0 },
        vwapDeviation: { enabled: false },
      },
    )

    expect(analysis.volumeProfiles[0].pocPrice).toBe(10.05)
  })

  it('classifies repeated bullish structure breaks as MSS then BOS', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(0, 9, 10, 7, 9),
      c(1, 10, 12, 8, 11),
      c(2, 12, 16, 11, 15),
      c(3, 15, 14, 10, 12),
      c(4, 12, 13, 9, 11),
      c(5, 11, 12, 8, 10),
      c(6, 10, 11, 7, 9),
      c(7, 9, 12, 8, 11),
      c(8, 11, 17, 10, 17),
      c(9, 17, 18, 16, 17),
      c(10, 17, 16, 13, 15),
      c(11, 15, 15, 11, 12),
      c(12, 12, 14, 10, 13),
      c(13, 13, 19, 12, 19),
      c(14, 19, 20, 18, 19),
    ], {
      internalLookback: 2,
      swingLookback: 50,
      useCloseBreak: false,
    })

    expect(analysis.structureEvents.map((event) => [event.direction, event.type, event.index])).toEqual([
      ['bullish', 'MSS', 8],
      ['bullish', 'BOS', 13],
    ])
  })

  it('builds volume profile, stop zones, unusual-volume and VWAP-deviation signals', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      { time: 0, open: 10, high: 10.5, low: 9.5, close: 10, volume: 100, vwap: 10 },
      { time: 1, open: 10, high: 11, low: 9.8, close: 10.5, volume: 100, vwap: 10 },
      { time: 2, open: 10.5, high: 12, low: 10, close: 11.5, volume: 110, vwap: 10.1 },
      { time: 3, open: 11.5, high: 11.8, low: 9.5, close: 10, volume: 90, vwap: 10 },
      { time: 4, open: 10, high: 10.2, low: 8.8, close: 9, volume: 95, vwap: 9.9 },
      { time: 5, open: 9, high: 13.2, low: 8.9, close: 12.8, volume: 400, vwap: 10.2 },
      { time: 6, open: 12.8, high: 13, low: 12, close: 12.5, volume: 180, vwap: 10.3 },
    ], {
      internalLookback: 1,
      swingLookback: 1,
      volumeProfile: { enabled: true, mode: 'rolling', lookback: 7, bins: 40, valueAreaPercent: 70, smoothing: 2 },
      stopZone: { enabled: true, pivotLookback: 1, maxActive: 10, volumeMultiplier: 1 },
      unusualVolume: { enabled: true, baselineLookback: 3, zScoreThreshold: 0.5, rvolThreshold: 1.1 },
      vwapDeviation: { enabled: true, bandLookback: 3, stdDevMultiplier: 0.8, signalEnabled: true },
    })

    expect(analysis.volumeProfiles.length).toBeGreaterThan(0)
    expect(analysis.stopZones.length).toBeGreaterThan(0)
    expect(analysis.summary.volumeProfiles).toBeGreaterThan(0)
    expect(analysis.summary.stopZones).toBeGreaterThan(0)
    expect(analysis.volumePriceSignals.some((signal) => signal.kind === 'unusual_volume')).toBe(true)
    expect(analysis.volumePriceSignals.some((signal) => signal.kind === 'vwap_deviation')).toBe(true)
    expect(analysis.volumePriceSignals.some((signal) => signal.kind === 'stop_run')).toBe(true)
  })

  it('sorts candles, ignores invalid rows, and reports warnings', () => {
    const analysis = new TechnicalAnalysisAnalyzer().analyze([
      c(2, 10, 11, 9, 10),
      { time: 1, open: 10, high: 8, low: 9, close: 10, volume: 100 },
      c(0, 9, 10, 8, 9),
    ], { internalLookback: 2, swingLookback: 2 })

    expect(analysis.summary.candles).toBe(2)
    expect(analysis.warnings.some((warning) => warning.includes('invalid candles'))).toBe(true)
    expect(analysis.warnings).toContain('Candles were sorted by time before analysis.')
  })
})
