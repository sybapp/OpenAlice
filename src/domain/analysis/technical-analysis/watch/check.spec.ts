/**
 * `checkWatch` specs: live-data orchestration over a faked `BarService`.
 * Fetch failure is `unavailable` (never a miss); the closed-bar gate drops
 * the in-progress bar before judging; a strongly bearish window judges the
 * bearish leaf as a hit end-to-end (real `analyzePriceActionBars` +
 * indicators, forced fib/confluence off).
 */
import { describe, expect, it, vi } from 'vitest'

import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import { checkWatch } from './check.js'
import type { IssueWatch } from './spec.js'

function bar(date: string, close: number): OhlcvBar {
  return { date, open: close - 1, high: close + 1, low: close - 1, close, volume: 100 }
}

/** Sustained downtrend: 200 daily closes 300 → 101. */
function downtrend(): OhlcvBar[] {
  return Array.from({ length: 200 }, (_, i) => {
    const close = 300 - i
    return bar(`2023-06-${String((i % 28) + 1).padStart(2, '0')}`, close)
  }).map((entry, i) => ({ ...entry, date: `day-${String(i).padStart(4, '0')}` }))
}

function watch(rule: IssueWatch['rule'], version = 1): IssueWatch {
  return {
    version,
    source: { barId: 'vendor|X', interval: '1d' },
    rule,
  }
}

describe('checkWatch', () => {
  it('maps a fetch throw to unavailable, never miss', async () => {
    const barService = { getBars: vi.fn(() => { throw new Error('source down') }) }
    const out = await checkWatch(
      { barService },
      watch({ type: 'price_above', price: 1 }),
      Date.parse('2024-01-01T00:00:00Z'),
    )
    expect(out.status).toBe('unavailable')
    expect(out.reason).toMatch(/bar fetch failed: source down/)
    expect(out.evidence.watchVersion).toBe(1)
  })

  it('judges a bearish EMA alignment hit on a real downtrend window', async () => {
    const bars = downtrend()
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars.at(-1)!.date, bars: bars.length, staleTradingDays: 0 },
      })),
    }
    const out = await checkWatch(
      { barService },
      watch({ type: 'ema_alignment', direction: 'bearish' }),
      Date.parse('2024-01-01T00:00:00Z'),
    )
    expect(out.status).toBe('hit')
    expect(out.leaves[0]).toMatchObject({ status: 'hit', actual: 'bearish' })
    expect(out.evidence.watchVersion).toBe(1)
    expect(out.evidence.dataAsOf).toBe(bars.at(-1)!.date)
    expect(barService.getBars).toHaveBeenCalledWith(
      { barId: 'vendor|X' },
      { interval: '1d', count: 200 },
    )
  })

  it('reports unavailable when the window is stale', async () => {
    const bars = downtrend()
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars.at(-1)!.date, bars: bars.length, staleTradingDays: 5 },
      })),
    }
    const out = await checkWatch(
      { barService },
      watch({ type: 'price_above', price: 0 }),
      Date.parse('2024-01-01T00:00:00Z'),
    )
    expect(out.status).toBe('unavailable')
    expect(out.reason).toMatch(/trading day\(s\) behind/)
  })

  it('reports unavailable for a cross on a single-bar window (needs two closes)', async () => {
    const bars = [bar('2024-01-02', 101)]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[0]!.date, bars: 1, staleTradingDays: 0 },
      })),
    }
    const out = await checkWatch(
      { barService },
      watch({ type: 'price_cross_above', price: 100 }),
      Date.parse('2024-01-03T00:00:00Z'),
    )
    expect(out.status).toBe('unavailable')
    expect(out.leaves[0]?.status).toBe('unavailable')
    expect(out.leaves[0]?.reason).toMatch(/two closed bars/)
  })

  it('reports unavailable when volume is absent and VWAP cannot judge', async () => {
    const bars = [
      { ...bar('2024-01-01', 100), volume: null },
      { ...bar('2024-01-02', 101), volume: null },
      { ...bar('2024-01-03', 102), volume: null },
    ]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[2]!.date, bars: 3, staleTradingDays: 0 },
      })),
    }
    const out = await checkWatch(
      { barService },
      watch({ type: 'price_vs_vwap', relation: 'above' }),
      Date.parse('2024-01-04T00:00:00Z'),
    )
    expect(out.status).toBe('unavailable')
    expect(out.leaves[0]?.status).toBe('unavailable')
    expect(out.leaves[0]?.reason).toMatch(/VWAP/)
  })

  it('reads no confirmed structure on a flat short window (miss, not a phantom hit)', async () => {
    const bars = [bar('2024-01-01', 100), bar('2024-01-02', 100), bar('2024-01-03', 100)]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[2]!.date, bars: 3, staleTradingDays: 0 },
      })),
    }
    const out = await checkWatch(
      { barService },
      watch({ type: 'structure_break', kind: 'any' }),
      Date.parse('2024-01-04T00:00:00Z'),
    )
    expect(out.status).toBe('miss')
    expect(out.signalIds).toEqual([])
  })

  it('drops the in-progress intraday bar before judging', async () => {
    const bars = [bar('2024-01-02 09:00', 100), bar('2024-01-02 10:00', 50)]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[1]!.date, bars: 2, staleTradingDays: 0 },
      })),
    }
    // Judged on the closed 09:00 bar (close 100), not the open 10:00 bar (close 50).
    const out = await checkWatch(
      { barService },
      {
        version: 3,
        source: { barId: 'vendor|X', interval: '1h' },
        rule: { type: 'price_above', price: 90 },
      },
      Date.parse('2024-01-02T10:30:00Z'),
    )
    expect(out.status).toBe('hit')
    expect(out.evidence.close).toBe(100)
    expect(out.evidence.watchVersion).toBe(3)
  })

  it('keeps a failed context local when another source satisfies any', async () => {
    const bars = [bar('2024-01-02', 200)]
    const barService = {
      getBars: vi.fn(async (ref: { barId: string }) => {
        if (ref.barId === 'vendor|down') throw new Error('down')
        return { bars, meta: { symbol: 'X', from: bars[0]!.date, to: bars[0]!.date, bars: 1, staleTradingDays: 0 } }
      }),
    }
    const out = await checkWatch({ barService }, {
      version: 1,
      source: { barId: 'vendor|down', interval: '1d' },
      sources: { daily: { barId: 'vendor|up', interval: '1d' } },
      rule: {
        any: [
          { type: 'price_above', price: 100 },
          { type: 'price_above', source: 'daily', price: 190 },
        ],
      },
    }, Date.parse('2024-01-03T00:00:00Z'))
    expect(out).toMatchObject({
      status: 'hit',
      leaves: [{ source: 'default', status: 'unavailable' }, { source: 'daily', status: 'hit' }],
      evidence: { contexts: { default: { status: 'unavailable' }, daily: { status: 'ready', barCount: 1 } } },
    })
  })

  it('deduplicates identical bar fetches across named sources', async () => {
    const bars = [bar('2024-01-02', 200)]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[0]!.date, bars: 1, staleTradingDays: 0 },
      })),
    }
    const source = { barId: 'vendor|X', interval: '1d' as const }
    const out = await checkWatch({ barService }, {
      version: 1,
      source: { barId: 'vendor|default', interval: '1d' },
      sources: { first: source, second: source },
      rule: {
        all: [
          { type: 'price_above', source: 'first', price: 190 },
          { type: 'price_above', source: 'second', price: 190 },
        ],
      },
    }, Date.parse('2024-01-03T00:00:00Z'))
    expect(out.status).toBe('hit')
    expect(barService.getBars).toHaveBeenCalledTimes(1)
  })

  it('caps five unique context fetches at four concurrent requests', async () => {
    const bars = [bar('2024-01-02', 200)]
    let active = 0
    let peak = 0
    let release: (() => void) | undefined
    const firstFour = new Promise<void>((resolve) => { release = resolve })
    const barService = {
      getBars: vi.fn(async () => {
        active += 1
        peak = Math.max(peak, active)
        if (active === 4) release?.()
        await firstFour
        active -= 1
        return { bars, meta: { symbol: 'X', from: bars[0]!.date, to: bars[0]!.date, bars: 1, staleTradingDays: 0 } }
      }),
    }
    const out = await checkWatch({ barService }, {
      version: 1,
      source: { barId: 'vendor|default', interval: '1d' },
      sources: {
        d1: { barId: 'vendor|d1', interval: '1d' },
        h4: { barId: 'vendor|h4', interval: '4h' },
        h1: { barId: 'vendor|h1', interval: '1h' },
        m30: { barId: 'vendor|m30', interval: '30m' },
      },
      rule: {
        all: [
          { type: 'price_above', price: 1 },
          { type: 'price_above', source: 'd1', price: 1 },
          { type: 'price_above', source: 'h4', price: 1 },
          { type: 'price_above', source: 'h1', price: 1 },
          { type: 'price_above', source: 'm30', price: 1 },
        ],
      },
    }, Date.parse('2024-01-03T00:00:00Z'))
    expect(out.status).toBe('hit')
    expect(peak).toBe(4)
    expect(barService.getBars).toHaveBeenCalledTimes(5)
  })

  it('keeps evidence key order deterministic and drops top-level dataAsOf when default is unused', async () => {
    const bars = [bar('2024-01-02', 200)]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[0]!.date, bars: 1, staleTradingDays: 0 },
      })),
    }
    const out = await checkWatch({ barService }, {
      version: 1,
      source: { barId: 'vendor|default', interval: '1d' },
      sources: {
        b: { barId: 'vendor|b', interval: '1d' },
        a: { barId: 'vendor|a', interval: '1d' },
      },
      rule: {
        all: [
          { type: 'price_above', source: 'b', price: 1 },
          { type: 'price_above', source: 'a', price: 1 },
        ],
      },
    }, Date.parse('2024-01-03T00:00:00Z'))
    expect(out.status).toBe('hit')
    expect(Object.keys(out.evidence.contexts ?? {})).toEqual(['b', 'a'])
    expect(out.evidence.dataAsOf).toBeUndefined()
    expect(out.evidence.contexts?.b?.dataAsOf).toBe(bars[0]!.date)
  })

  it('does not treat a forming bar range as a price_touch', async () => {
    const bars = [bar('2024-01-02 09:00', 100), bar('2024-01-02 10:00', 50)]
    const barService = {
      getBars: vi.fn(async () => ({
        bars,
        meta: { symbol: 'X', from: bars[0]!.date, to: bars[1]!.date, bars: 2, staleTradingDays: 0 },
      })),
    }
    const out = await checkWatch(
      { barService },
      {
        version: 3,
        source: { barId: 'vendor|X', interval: '1h' },
        freshness: { maxStaleMinutes: 60 },
        rule: { type: 'price_touch', price: 50 },
      },
      Date.parse('2024-01-02T10:30:00Z'),
    )
    expect(out.status).toBe('miss')
    expect(out.leaves[0]).toMatchObject({ status: 'miss', actual: 0 })
  })
})
