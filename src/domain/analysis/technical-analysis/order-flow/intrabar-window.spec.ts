import { describe, expect, it, vi } from 'vitest'
import { loadIntrabarWindow } from './intrabar-window.js'
import type { BarService, BarsResult } from '@/domain/market-data/bars/index.js'
import type { OhlcvBar } from '@/domain/market-data/bars/types.js'

describe('loadIntrabarWindow', () => {
  it('fetches capped target bars then fetches intrabars over the target date window', async () => {
    const getBars = vi.fn()
      .mockResolvedValueOnce({
        bars: [
          { date: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ],
        meta: {
          symbol: 'AAPL',
          from: '2024-01-01',
          to: '2024-01-01',
          bars: 1,
          supportedIntervals: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
        },
      } as BarsResult)
      .mockResolvedValueOnce({
        bars: [
          { date: '2024-01-01 00:00:00', open: 100, high: 101, low: 99, close: 101, volume: 100 },
        ],
        meta: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-01', bars: 1 },
      } as BarsResult)
    const barService = {
      getBars,
      getSourceCapabilities: async () => ({
        supportedIntervals: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
      }),
    } as unknown as BarService

    const result = await loadIntrabarWindow({
      barService,
      ref: { barId: 'tradingview|AAPL', assetClass: 'equity' },
      targetInterval: '1w',
      requestedCount: 800,
    })

    expect(result.status).toBe('available')
    expect(getBars).toHaveBeenNthCalledWith(1, { barId: 'tradingview|AAPL', assetClass: 'equity' }, {
      interval: '1w',
      count: 714,
      start: undefined,
      end: undefined,
    })
    expect(getBars).toHaveBeenNthCalledWith(2, { barId: 'tradingview|AAPL', assetClass: 'equity' }, {
      interval: '1d',
      start: '2024-01-01',
      end: '2024-01-02',
    })
    expect(result.plan.truncated).toBe(true)
    expect(result.targetBars).toHaveLength(1)
    expect(result.intrabars).toHaveLength(1)
  })

  it('slices supplied target bars to the supported intrabar window and reports the absolute offset', async () => {
    const bars = makeBars(122)
    const getBars = vi.fn(async () => ({
      bars: [{ date: '2024-01-04 00:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      meta: { symbol: 'AAPL', from: '2024-01-04', to: '2024-01-06', bars: 1 },
    } as BarsResult))
    const barService = { getBars } as unknown as BarService

    const result = await loadIntrabarWindow({
      barService,
      ref: { symbol: 'AAPL', assetClass: 'equity' },
      targetInterval: '1000h',
      requestedCount: bars.length,
      targetBars: bars,
    })

    expect(result.status).toBe('available')
    expect(result.targetBars).toHaveLength(119)
    expect(result.targetIndexOffset).toBe(3)
    expect(result.targetBars[0]!.date).toBe('2024-01-04')
    expect(getBars).toHaveBeenCalledWith({ symbol: 'AAPL', assetClass: 'equity' }, {
      interval: '1d',
      start: '2024-01-04',
      end: '2024-05-02',
    })
  })

  it('returns no_intrabars with plan metadata when the lower-timeframe fetch is empty', async () => {
    const getBars = vi.fn(async () => ({
      bars: [],
      meta: { symbol: 'AAPL', from: '', to: '', bars: 0 },
    } as BarsResult))
    const barService = { getBars } as unknown as BarService

    const result = await loadIntrabarWindow({
      barService,
      ref: { symbol: 'AAPL', assetClass: 'equity' },
      targetInterval: '15m',
      requestedCount: 1,
      targetBars: [
        { date: '2024-01-01 09:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    })

    expect(result.status).toBe('no_intrabars')
    expect(result.plan.intrabarInterval).toBe('1m')
    expect(result.intrabars).toEqual([])
  })

  it('keeps only intrabars inside the target-bar window', async () => {
    const getBars = vi.fn(async () => ({
      bars: [
        { date: '2024-01-01 08:59:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: '2024-01-01 09:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: '2024-01-01 09:59:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: '2024-01-01 10:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
      meta: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-01', bars: 4 },
    } as BarsResult))
    const result = await loadIntrabarWindow({
      barService: { getBars } as unknown as BarService,
      ref: { symbol: 'AAPL', assetClass: 'equity' },
      targetInterval: '1h',
      requestedCount: 1,
      targetBars: [{ date: '2024-01-01 09:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    })

    expect(result.intrabars.map((bar) => bar.date)).toEqual([
      '2024-01-01 09:00:00',
      '2024-01-01 09:59:00',
    ])
  })

  it('degrades to no_intrabars when the lower-timeframe fetch throws', async () => {
    const getBars = vi.fn(async () => {
      throw new Error('TradingView socket timeout')
    })
    const targetBars = [
      { date: '2024-01-01 09:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]

    const result = await loadIntrabarWindow({
      barService: { getBars } as unknown as BarService,
      ref: { symbol: 'AAPL', assetClass: 'equity' },
      targetInterval: '1h',
      requestedCount: 1,
      targetBars,
    })

    expect(result.status).toBe('no_intrabars')
    expect(result.intrabars).toEqual([])
    // The target bars survive — order flow degrades, the interval does not die.
    expect(result.targetBars).toEqual(targetBars)
    expect(result.plan.degradationReason).toContain('TradingView socket timeout')
  })

  it('does not request same-timeframe or unsupported intrabars', async () => {
    const getBars = vi.fn()
    const oneMinute = await loadIntrabarWindow({
      barService: { getBars } as unknown as BarService,
      ref: { symbol: 'AAPL', assetClass: 'equity' },
      targetInterval: '1m',
      requestedCount: 1,
      targetBars: [{ date: '2024-01-01 09:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    })
    const noLowerInterval = await loadIntrabarWindow({
      barService: { getBars } as unknown as BarService,
      ref: { symbol: 'AAPL', assetClass: 'equity' },
      targetInterval: '1h',
      requestedCount: 1,
      targetMeta: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-01', bars: 1, supportedIntervals: ['1h'] },
      targetBars: [{ date: '2024-01-01 09:00:00', open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    })

    expect(oneMinute).toMatchObject({ status: 'no_intrabars', intrabars: [], plan: { intrabarInterval: 'unavailable' } })
    expect(noLowerInterval).toMatchObject({ status: 'no_intrabars', intrabars: [], plan: { intrabarInterval: 'unavailable' } })
    expect(getBars).not.toHaveBeenCalled()
  })
})

function makeBars(count: number): OhlcvBar[] {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index, 0, 0, 0)).toISOString().slice(0, 10),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 100,
  }))
}
