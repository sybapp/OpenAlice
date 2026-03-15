import { describe, it, expect, vi } from 'vitest'
import type { OhlcvData } from '../indicator/types'
import { createOhlcvStore, __private__ } from './store'

describe('OhlcvStore', () => {
  it('dedupes in-flight requests for same key', async () => {
    const raw: OhlcvData[] = [{
      date: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }]

    let resolve!: (v: unknown[]) => void
    const getHistorical = vi.fn(() => new Promise<unknown[]>((r) => { resolve = r }))

    const store = createOhlcvStore({
      cryptoClient: { getHistorical },
      ttlMs: 120_000,
      maxSize: 50,
    })

    const p1 = store.fetch({ asset: 'crypto', symbol: 'TEST', interval: '1h', strategy: 'bars', lookbackBars: 10 })
    const p2 = store.fetch({ asset: 'crypto', symbol: 'TEST', interval: '1h', strategy: 'bars', lookbackBars: 10 })

    expect(getHistorical).toHaveBeenCalledTimes(1)

    resolve(raw as unknown[])
    const [a, b] = await Promise.all([p1, p2])

    expect(a).toEqual(raw)
    expect(b).toEqual(raw)
    expect(getHistorical).toHaveBeenCalledTimes(1)
  })

  it('caches raw data but applies dropUnclosed per-call', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-01-01T10:02:00.000Z').getTime()
    vi.setSystemTime(now)

    // 1h bars: last bar starts at 10:30, ends at 11:30 (unclosed at 10:02) -> should be dropped
    const bars: OhlcvData[] = [
      {
        date: new Date('2026-01-01T09:30:00.000Z').toISOString(),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      },
      {
        date: new Date('2026-01-01T10:30:00.000Z').toISOString(),
        open: 2,
        high: 2,
        low: 2,
        close: 2,
        volume: 1,
      },
    ]

    const getHistorical = vi.fn(async () => bars as unknown[])

    const store = createOhlcvStore({
      cryptoClient: { getHistorical },
    })

    const full = await store.fetch({
      asset: 'crypto',
      symbol: 'TEST',
      interval: '1h',
      strategy: 'calendar',
      calendarDays: 10,
    })

    const dropped = await store.fetch({
      asset: 'crypto',
      symbol: 'TEST',
      interval: '1h',
      strategy: 'calendar',
      calendarDays: 10,
      dropUnclosed: true,
    })

    expect(full).toHaveLength(2)
    expect(dropped).toHaveLength(1)
    // only 1 API call thanks to cache
    expect(getHistorical).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('dropUnclosedBar keeps last bar when closed', () => {
    vi.useFakeTimers()
    const now = new Date('2026-01-01T11:35:00.000Z').getTime()
    vi.setSystemTime(now)

    const bars: OhlcvData[] = [{
      date: new Date('2026-01-01T10:30:00.000Z').toISOString(),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }]

    const out = __private__.dropUnclosedBar(bars, '1h')
    expect(out).toHaveLength(1)

    vi.useRealTimers()
  })
})
