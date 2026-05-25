import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCachedEquityClient, filterClosedBars, OhlcvCacheService, rangeSatisfied } from './cache-service.js'
import { OhlcvCacheStore } from './store.js'
import type { EquityClientLike } from '../client/types.js'

describe('OhlcvCacheService', () => {
  let rootDir: string
  let store: OhlcvCacheStore
  let service: OhlcvCacheService

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'ohlcv-service-'))
    store = new OhlcvCacheStore({ rootDir })
    service = new OhlcvCacheService({
      store,
      config: { enabled: true, dir: rootDir, maxGapRequests: 4, writeClosedOnly: true },
      providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' },
      now: () => new Date('2026-05-07T10:12:00Z'),
    })
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('returns a cache hit without calling the fetcher', async () => {
    await store.writeMerged({ provider: 'yfinance', asset: 'equity', symbol: 'QQQ', interval: '5m' }, [
      { date: '2026-05-07 09:55:00', open: 1, high: 2, low: 1, close: 2, volume: 100 },
      { date: '2026-05-07 10:00:00', open: 2, high: 3, low: 2, close: 3, volume: 200 },
      { date: '2026-05-07 10:05:00', open: 3, high: 4, low: 3, close: 4, volume: 300 },
    ])
    const fetcher = vi.fn()

    const rows = await service.getHistorical(
      'equity',
      { symbol: 'QQQ', interval: '5m', start_date: '2026-05-07 10:00:00', end_date: '2026-05-07 10:05:00' },
      fetcher,
    )

    expect(fetcher).not.toHaveBeenCalled()
    expect(rows.map((row) => row.date)).toEqual(['2026-05-07 10:00:00', '2026-05-07 10:05:00'])
  })

  it('fetches and writes only closed bars on a miss', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { date: '2026-05-07 10:00:00', open: 1, high: 2, low: 1, close: 2, volume: 100 },
      { date: '2026-05-07 10:10:00', open: 2, high: 3, low: 2, close: 3, volume: 200 },
    ])

    const rows = await service.getHistorical('equity', { symbol: 'QQQ', interval: '5m' }, fetcher)
    const cached = await store.readAll({ provider: 'yfinance', asset: 'equity', symbol: 'QQQ', interval: '5m' })

    expect(rows.map((row) => row.date)).toEqual(['2026-05-07 10:00:00'])
    expect(cached.map((row) => row.date)).toEqual(['2026-05-07 10:00:00'])
  })

  it('fetches only the missing right edge when cached data is partial', async () => {
    await store.writeMerged({ provider: 'yfinance', asset: 'equity', symbol: 'QQQ', interval: '5m' }, [
      { date: '2026-05-07 09:55:00', open: 1, high: 2, low: 1, close: 2, volume: 100 },
      { date: '2026-05-07 10:00:00', open: 2, high: 3, low: 2, close: 3, volume: 200 },
    ])
    const fetcher = vi.fn().mockResolvedValue([
      { date: '2026-05-07 10:05:00', open: 3, high: 4, low: 3, close: 4, volume: 300 },
    ])

    const rows = await service.getHistorical(
      'equity',
      { symbol: 'QQQ', interval: '5m', start_date: '2026-05-07 09:55:00', end_date: '2026-05-07 10:05:00' },
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith({
      symbol: 'QQQ',
      interval: '5m',
      start_date: '2026-05-07 10:05:00',
      end_date: '2026-05-07 10:05:00',
    })
    expect(rows.map((row) => row.date)).toEqual([
      '2026-05-07 09:55:00',
      '2026-05-07 10:00:00',
      '2026-05-07 10:05:00',
    ])
  })

  it('returns useful cached daily bars when the trailing provider gap is empty', async () => {
    const daily = new OhlcvCacheService({
      store,
      config: { enabled: true, dir: rootDir, maxGapRequests: 4, writeClosedOnly: true },
      providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' },
      now: () => new Date('2026-05-25T12:00:00Z'),
    })
    await store.writeMerged({ provider: 'yfinance', asset: 'equity', symbol: 'NOW', interval: '1d' }, [
      { date: '2026-05-21', open: 1, high: 2, low: 1, close: 2, volume: 100 },
      { date: '2026-05-22', open: 2, high: 3, low: 2, close: 3, volume: 200 },
    ])
    const fetcher = vi.fn().mockRejectedValue(new Error('No historical data returned'))

    const rows = await daily.getHistorical(
      'equity',
      { symbol: 'NOW', interval: '1d', start_date: '2026-05-21' },
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith({
      symbol: 'NOW',
      interval: '1d',
      start_date: '2026-05-23',
    })
    expect(rows.map((row) => row.date)).toEqual(['2026-05-21', '2026-05-22'])
  })

  it('bypasses the store when disabled', async () => {
    const disabled = new OhlcvCacheService({
      store,
      config: { enabled: false, dir: rootDir, maxGapRequests: 4, writeClosedOnly: true },
      providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' },
    })
    const fetcher = vi.fn().mockResolvedValue([{ date: '2026-05-07', open: 1, high: 1, low: 1, close: 1 }])

    await expect(disabled.getHistorical('equity', { symbol: 'QQQ', interval: '1d' }, fetcher)).resolves.toHaveLength(1)
    await expect(store.readAll({ provider: 'yfinance', asset: 'equity', symbol: 'QQQ', interval: '1d' })).resolves.toEqual([])
  })

  it('proxies clients while preserving non-overridden methods', async () => {
    class Client {
      async getHistorical() {
        return [{ date: '2026-05-07 10:00:00', open: 1, high: 1, low: 1, close: 1 }]
      }

      async search(params: Record<string, unknown>) {
        return [{ symbol: params.symbol }]
      }
    }

    const client = new Client() as unknown as EquityClientLike
    const cached = createCachedEquityClient(client, service)

    await expect(cached.search({ symbol: 'QQQ' })).resolves.toEqual([{ symbol: 'QQQ' }])
    await expect(cached.getHistorical({ symbol: 'QQQ', interval: '5m' })).resolves.toHaveLength(1)
  })
})

describe('OHLCV cache helpers', () => {
  it('filters out the currently forming bar', () => {
    const rows = filterClosedBars([
      { date: '2026-05-07 10:00:00', open: 1, high: 1, low: 1, close: 1 },
      { date: '2026-05-07 10:10:00', open: 1, high: 1, low: 1, close: 1 },
    ], '5m', new Date('2026-05-07T10:12:00Z'))

    expect(rows.map((row) => row.date)).toEqual(['2026-05-07 10:00:00'])
  })

  it('treats a date-only start as satisfied by intraday bars on that date', () => {
    expect(rangeSatisfied([
      { date: '2026-05-07 09:30:00', open: 1, high: 1, low: 1, close: 1, volume: null },
      { date: '2026-05-07 10:00:00', open: 1, high: 1, low: 1, close: 1, volume: null },
    ], { startDate: '2026-05-07', endDate: '2026-05-07 10:00:00' }, '5m', new Date('2026-05-07T10:12:00Z'))).toBe(true)
  })
})
