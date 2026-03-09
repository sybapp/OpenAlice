import { describe, it, expect } from 'vitest'
import { HistoricalMarketReplay } from './HistoricalMarketReplay.js'
import type { BacktestBar } from './types.js'

function makeBar(overrides: Partial<BacktestBar> = {}): BacktestBar {
  return {
    ts: '2025-01-01T09:30:00.000Z',
    open: 100,
    high: 105,
    low: 99,
    close: 102,
    volume: 1_000,
    symbol: 'AAPL',
    ...overrides,
  }
}

describe('HistoricalMarketReplay', () => {
  it('loads bars and exposes current time/quote at start', async () => {
    const replay = new HistoricalMarketReplay({
      bars: [makeBar(), makeBar({ ts: '2025-01-01T09:31:00.000Z', open: 102, high: 106, low: 101, close: 105 })],
    })

    await replay.init()

    expect(replay.getCurrentIndex()).toBe(0)
    expect(replay.getCurrentTime().toISOString()).toBe('2025-01-01T09:30:00.000Z')

    const quote = replay.getCurrentQuote('AAPL')
    expect(quote.last).toBe(102)
    expect(quote.high).toBe(105)
    expect(quote.low).toBe(99)
  })

  it('advances to the next timestamp snapshot for multi-symbol bars', async () => {
    const replay = new HistoricalMarketReplay({
      bars: [
        makeBar({ symbol: 'AAPL', ts: '2025-01-01T09:30:00.000Z', close: 101 }),
        makeBar({ symbol: 'MSFT', ts: '2025-01-01T09:30:00.000Z', close: 201 }),
        makeBar({ symbol: 'AAPL', ts: '2025-01-01T09:31:00.000Z', close: 102 }),
        makeBar({ symbol: 'MSFT', ts: '2025-01-01T09:31:00.000Z', close: 202 }),
      ],
    })

    await replay.init()

    expect(replay.getCurrentBars().map((bar) => `${bar.symbol}@${bar.ts}`)).toEqual([
      'AAPL@2025-01-01T09:30:00.000Z',
      'MSFT@2025-01-01T09:30:00.000Z',
    ])

    const moved = replay.step()

    expect(moved).toBe(true)
    expect(replay.getCurrentTime().toISOString()).toBe('2025-01-01T09:31:00.000Z')
    expect(replay.getCurrentBars().map((bar) => `${bar.symbol}@${bar.ts}`)).toEqual([
      'AAPL@2025-01-01T09:31:00.000Z',
      'MSFT@2025-01-01T09:31:00.000Z',
    ])
  })

  it('returns false when stepping past the end', async () => {
    const replay = new HistoricalMarketReplay({ bars: [makeBar()] })
    await replay.init()

    expect(replay.step()).toBe(false)
    expect(replay.isFinished()).toBe(true)
  })

  it('supports starting from a requested start time', async () => {
    const replay = new HistoricalMarketReplay({
      bars: [
        makeBar({ ts: '2025-01-01T09:30:00.000Z' }),
        makeBar({ ts: '2025-01-01T09:31:00.000Z' }),
        makeBar({ ts: '2025-01-01T09:32:00.000Z' }),
      ],
      startTime: '2025-01-01T09:31:00.000Z',
    })

    await replay.init()

    expect(replay.getCurrentIndex()).toBe(1)
    expect(replay.getCurrentTime().toISOString()).toBe('2025-01-01T09:31:00.000Z')
  })

  it('throws when bar data is empty', async () => {
    const replay = new HistoricalMarketReplay({ bars: [] })
    await expect(replay.init()).rejects.toThrow('No historical bars')
  })

  it('throws when symbol data is missing at current bar', async () => {
    const replay = new HistoricalMarketReplay({ bars: [makeBar({ symbol: 'MSFT' })] })
    await replay.init()

    expect(() => replay.getCurrentQuote('AAPL')).toThrow('No bar for symbol')
  })
})
