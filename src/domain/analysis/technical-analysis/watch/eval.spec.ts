/**
 * Fixed-bar replay specs for the pure `watch` evaluator (increment 1).
 * No network, no clock: every case builds bars + computed inputs by hand and
 * asserts deterministic hit / miss / unavailable verdicts.
 */
import { describe, expect, it } from 'vitest'

import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import type { TechnicalAnalysisIndicatorResult } from '../indicators.js'
import type { PriceActionAnalysisResult } from '../price-action/analyze.js'
import type { MarketStructureAnalysis } from '../price-action/types.js'
import { evaluateWatch, type WatchEvalInput } from './eval.js'
import type { WatchRule } from './spec.js'

function bar(date: string, close: number, extra: Partial<OhlcvBar> = {}): OhlcvBar {
  return {
    date,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    ...extra,
  }
}

function uptrend(count: number, start = 100, step = 2): OhlcvBar[] {
  return Array.from({ length: count }, (_, i) =>
    bar(`2024-01-${String(i + 1).padStart(2, '0')}`, start + i * step))
}

function indicators(over: Partial<TechnicalAnalysisIndicatorResult> = {}): TechnicalAnalysisIndicatorResult {
  return {
    configuration: {
      emaPeriods: { fast: 3, slow: 5, long: 8 },
      vwap: { enabled: true, anchor: 'auto', volumeLookback: 4 },
      fib: { enabled: true, levels: [0.5] },
      confluence: { enabled: true, minFamilies: 2, overlapAtrMultiplier: 0.25, maxVisible: 8 },
      atrPeriod: 14,
    },
    ema: { fast: 110, slow: 108, long: 105, bias: 'bullish' },
    vwap: { value: 107, anchor: 'rolling', relation: 'above' },
    fibRetracements: [],
    confluenceZones: [],
    warnings: [],
    ...over,
  }
}

function structure(over: Partial<MarketStructureAnalysis> = {}): MarketStructureAnalysis {
  return {
    marketStructureMode: 'pivot',
    swingPoints: {
      internal: { highs: [], lows: [] },
      swing: { highs: [], lows: [] },
      external: { highs: [], lows: [] },
    },
    stateByLevel: {
      internal: { trend: 'bullish', trendValue: 1 },
      swing: { trend: 'bullish', trendValue: 1 },
      external: { trend: 'unknown', trendValue: 0 },
    },
    bos: [],
    choch: [],
    swingStrength: [],
    ...over,
  }
}

function priceAction(over: Partial<PriceActionAnalysisResult> = {}): PriceActionAnalysisResult {
  return {
    marketStructure: structure(),
    premiumDiscount: { status: 'unavailable', reason: 'missing_range' },
    liquidityPools: [],
    liquiditySweeps: [],
    fvgs: [],
    ifvgs: [],
    orderBlocks: [],
    breakers: [],
    meta: {
      schemaVersion: 2,
      volatility: {
        period: 14,
        currentVolatility: 1,
        fallback: { used: false, availableBars: 10 },
      },
      totalFvgCount: 0,
      returnedFvgCount: 0,
      totalIfvgCount: 0,
      returnedIfvgCount: 0,
      totalBreakerCount: 0,
      returnedBreakerCount: 0,
      totalOrderBlockCount: 0,
      returnedOrderBlockCount: 0,
      mitigatedOrderBlockCount: 0,
      bosCount: 0,
      chochCount: 0,
    },
    ...over,
  }
}

function input(
  bars: OhlcvBar[],
  over: { indicators?: TechnicalAnalysisIndicatorResult; priceAction?: PriceActionAnalysisResult } = {},
): WatchEvalInput {
  return {
    contexts: new Map([['default', {
      status: 'ready',
      bars,
      indicators: over.indicators ?? indicators(),
      priceAction: over.priceAction ?? priceAction(),
    }]]),
  }
}

describe('evaluateWatch — price leaves', () => {
  it('hits price_above when the last close exceeds the threshold', () => {
    const out = evaluateWatch(input(uptrend(10)), { type: 'price_above', price: 110 })
    expect(out.status).toBe('hit')
    expect(out.leaves[0]).toMatchObject({ status: 'hit', actual: 118, expected: 110 })
    expect(out.evidence).toMatchObject({ close: 118, barCount: 10 })
  })

  it('misses price_above when the last close is below the threshold', () => {
    const out = evaluateWatch(input(uptrend(10)), { type: 'price_above', price: 200 })
    expect(out.status).toBe('miss')
  })

  it('judges price_cross_above on consecutive closed bars only', () => {
    const bars = uptrend(5, 100, 2) // closes 100..108
    const hit = evaluateWatch(input(bars), { type: 'price_cross_above', price: 107 })
    expect(hit.status).toBe('hit') // 106 -> 108 crosses 107
    const miss = evaluateWatch(input(bars), { type: 'price_cross_above', price: 101 })
    expect(miss.status).toBe('miss') // both sides above
    const single = evaluateWatch(input(bars.slice(-1)), { type: 'price_cross_above', price: 107 })
    expect(single.status).toBe('unavailable')
    expect(single.leaves[0]?.reason).toMatch(/two closed bars/)
  })

  it('judges range membership on the last close', () => {
    const bars = uptrend(5) // last close 108
    expect(evaluateWatch(input(bars), { type: 'price_in_range', low: 100, high: 110 }).status).toBe('hit')
    expect(evaluateWatch(input(bars), { type: 'price_out_of_range', low: 100, high: 110 }).status).toBe('miss')
    expect(evaluateWatch(input(bars), { type: 'price_out_of_range', low: 200, high: 300 }).status).toBe('hit')
  })

  it('hits price_touch at an inclusive bar boundary', () => {
    const bars = [bar('2024-01-01', 100, { low: 99, high: 100 })]
    const out = evaluateWatch(input(bars), { type: 'price_touch', price: 100 })
    expect(out).toMatchObject({ status: 'hit', leaves: [{ status: 'hit', actual: 1, signalIds: [] }] })
  })

  it('uses only the configured closed-bar touch window', () => {
    const bars = [
      bar('2024-01-01', 100),
      bar('2024-01-02', 100, { low: 104, high: 106 }),
      bar('2024-01-03', 100),
      bar('2024-01-04', 100),
      bar('2024-01-05', 100),
    ]
    expect(evaluateWatch(input(bars), { type: 'price_touch', price: 105 }).status).toBe('miss')
    expect(evaluateWatch(input(bars), { type: 'price_touch', price: 105, lookbackBars: 4 }).status).toBe('hit')
  })
})

describe('evaluateWatch — indicator leaves', () => {
  it('hits ema_alignment when the bias matches', () => {
    const bars = uptrend(10)
    expect(evaluateWatch(input(bars), { type: 'ema_alignment', direction: 'bullish' }).status).toBe('hit')
    expect(evaluateWatch(input(bars), { type: 'ema_alignment', direction: 'bearish' }).status).toBe('miss')
  })

  it('reports unavailable when the EMA bias is unavailable', () => {
    const bars = uptrend(10)
    const ind = indicators({ ema: { bias: 'unavailable' } })
    const out = evaluateWatch(input(bars, { indicators: ind }), { type: 'ema_alignment', direction: 'bullish' })
    expect(out.status).toBe('unavailable')
    expect(out.leaves[0]?.reason).toMatch(/EMA bias/)
  })

  it('judges price_vs_ema against the selected leg', () => {
    const bars = uptrend(10) // last close 118
    expect(evaluateWatch(input(bars), { type: 'price_vs_ema', which: 'fast', relation: 'above' }).status).toBe('hit')
    expect(evaluateWatch(input(bars), { type: 'price_vs_ema', which: 'fast', relation: 'below' }).status).toBe('miss')
  })

  it('reports unavailable when the selected EMA leg is missing', () => {
    const bars = uptrend(10)
    const ind = indicators({ ema: { bias: 'bullish' } })
    const out = evaluateWatch(input(bars, { indicators: ind }), { type: 'price_vs_ema', which: 'slow', relation: 'above' })
    expect(out.status).toBe('unavailable')
    expect(out.leaves[0]?.reason).toMatch(/EMA slow/)
  })

  it('judges price_vs_vwap and surfaces anchor gaps as unavailable', () => {
    const bars = uptrend(10)
    expect(evaluateWatch(input(bars), { type: 'price_vs_vwap', relation: 'above' }).status).toBe('hit')
    expect(evaluateWatch(input(bars), { type: 'price_vs_vwap', relation: 'below' }).status).toBe('miss')
    const noVwap = indicators({ vwap: undefined })
    const out = evaluateWatch(input(bars, { indicators: noVwap }), { type: 'price_vs_vwap', relation: 'above' })
    expect(out.status).toBe('unavailable')
    expect(out.leaves[0]?.reason).toMatch(/VWAP/)
  })
})

describe('evaluateWatch — structure leaves', () => {
  const bosBars = uptrend(12)
  const bosEvent = {
    type: 'bullish' as const,
    index: 10,
    price: 120,
    level: 'swing' as const,
    brokenSwing: { index: 8, price: 116, type: 'high' as const },
  }

  it('hits structure_break on a matching confirmed event with a stable id', () => {
    const pa = priceAction({ marketStructure: structure({ bos: [bosEvent] }) })
    const out = evaluateWatch(input(bosBars, { priceAction: pa }), { type: 'structure_break', kind: 'BOS' })
    expect(out.status).toBe('hit')
    expect(out.signalIds).toHaveLength(1)
    expect(out.signalIds[0]).toContain('BOS|swing|bullish')
  })

  it('namespaces signal ids from a non-default context', () => {
    const pa = priceAction({ marketStructure: structure({ bos: [bosEvent] }) })
    const out = evaluateWatch({
      contexts: new Map([['daily', { status: 'ready' as const, bars: bosBars, priceAction: pa }]]),
    }, { type: 'structure_break', source: 'daily', kind: 'BOS' })
    expect(out.signalIds[0]).toMatch(/^daily\\|BOS\\|swing\\|bullish/)
  })

  it('misses on direction / kind mismatch and honors since', () => {
    const pa = priceAction({ marketStructure: structure({ bos: [bosEvent] }) })
    const inState = input(bosBars, { priceAction: pa })
    expect(evaluateWatch(inState, { type: 'structure_break', kind: 'BOS', direction: 'bearish' }).status).toBe('miss')
    expect(evaluateWatch(inState, { type: 'structure_break', kind: 'CHoCH' }).status).toBe('miss')
    // break bar is 2024-01-11; since after it excludes the event.
    expect(evaluateWatch(inState, { type: 'structure_break', kind: 'any', since: '2024-01-12' }).status).toBe('miss')
    expect(evaluateWatch(inState, { type: 'structure_break', kind: 'any', since: '2024-01-10' }).status).toBe('hit')
  })

  it('hits zone_touch when a recent bar overlaps an active zone', () => {
    const bars = uptrend(10) // last bar high 119 / low 117
    const pa = priceAction({
      fvgs: [{
        type: 'bullish',
        variant: 'FVG',
        top: 118.5,
        bottom: 117.5,
        formationIndex: 7,
        confirmationIndex: 8,
        size: 1,
        isFilled: false,
        fillPercentage: 0.2,
        completelyFilled: false,
      }],
    })
    const out = evaluateWatch(input(bars, { priceAction: pa }), { type: 'zone_touch', zone: 'FVG', relation: 'touch' })
    expect(out.status).toBe('hit')
    expect(out.signalIds).toHaveLength(1)
    expect(out.signalIds[0]).toContain('FVG')
  })

  it('ignores filled FVGs and mitigated OBs', () => {
    const bars = uptrend(10)
    const pa = priceAction({
      fvgs: [{
        type: 'bullish',
        variant: 'FVG',
        top: 118.5,
        bottom: 117.5,
        formationIndex: 7,
        confirmationIndex: 8,
        size: 1,
        isFilled: true,
        fillPercentage: 1,
        completelyFilled: true,
      }],
    })
    const out = evaluateWatch(input(bars, { priceAction: pa }), { type: 'zone_touch', zone: 'FVG', relation: 'touch' })
    expect(out.status).toBe('miss')
  })
})

describe('evaluateWatch — combination + empty window', () => {
  it('combines with all (every leaf must hit)', () => {
    const bars = uptrend(10)
    const rule: WatchRule = {
      all: [
        { type: 'price_above', price: 110 },
        { type: 'ema_alignment', direction: 'bullish' },
      ],
    }
    expect(evaluateWatch(input(bars), rule).status).toBe('hit')
    const failing: WatchRule = {
      all: [
        { type: 'price_above', price: 110 },
        { type: 'ema_alignment', direction: 'bearish' },
      ],
    }
    expect(evaluateWatch(input(bars), failing).status).toBe('miss')
  })

  it('all with an unavailable leaf is unavailable, not miss', () => {
    const bars = uptrend(10)
    const ind = indicators({ ema: { bias: 'unavailable' } })
    const rule: WatchRule = {
      all: [
        { type: 'price_above', price: 110 },
        { type: 'ema_alignment', direction: 'bullish' },
      ],
    }
    expect(evaluateWatch(input(bars, { indicators: ind }), rule).status).toBe('unavailable')
  })

  it('any hits when one leaf hits', () => {
    const bars = uptrend(10)
    const rule: WatchRule = {
      any: [
        { type: 'price_above', price: 500 },
        { type: 'ema_alignment', direction: 'bullish' },
      ],
    }
    const out = evaluateWatch(input(bars), rule)
    expect(out.status).toBe('hit')
    expect(out.leaves.map((leaf) => leaf.status)).toEqual(['miss', 'hit'])
  })

  it('is unavailable on an empty window', () => {
    const out = evaluateWatch(input([]), { type: 'price_above', price: 1 })
    expect(out.status).toBe('unavailable')
    expect(out.reason).toMatch(/no bars/)
  })

  it('evaluates each leaf against its named context', () => {
    const out = evaluateWatch({
      contexts: new Map([
        ['default', { status: 'ready' as const, bars: [bar('2024-01-01', 110)] }],
        ['daily', { status: 'ready' as const, bars: [bar('2024-01-01', 200)] }],
      ]),
    }, {
      all: [
        { type: 'price_above', price: 100 },
        { type: 'price_above', source: 'daily', price: 190 },
      ],
    })
    expect(out).toMatchObject({
      status: 'hit',
      leaves: [{ source: 'default', status: 'hit' }, { source: 'daily', status: 'hit' }],
      evidence: { contexts: { default: { barCount: 1 }, daily: { barCount: 1 } } },
    })
  })

  it('keeps a source failure local to its leaves', () => {
    const out = evaluateWatch({
      contexts: new Map([
        ['default', { status: 'unavailable' as const, reason: 'source down' }],
        ['daily', { status: 'ready' as const, bars: [bar('2024-01-01', 200)] }],
      ]),
    }, {
      any: [
        { type: 'price_above', price: 100 },
        { type: 'price_above', source: 'daily', price: 190 },
      ],
    })
    expect(out).toMatchObject({
      status: 'hit',
      leaves: [{ status: 'unavailable', reason: 'source down' }, { status: 'hit', source: 'daily' }],
    })
  })
})
