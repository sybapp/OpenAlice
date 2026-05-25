import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filterRange, OhlcvCacheStore } from './store.js'
import type { OhlcvPartitionKey } from './types.js'

describe('OhlcvCacheStore', () => {
  let rootDir: string
  const key: OhlcvPartitionKey = {
    provider: 'yfinance',
    asset: 'equity',
    symbol: 'QQQ',
    interval: '5m',
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'ohlcv-store-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('writes, normalizes, deduplicates, and sorts bars', async () => {
    const store = new OhlcvCacheStore({ rootDir, now: () => new Date('2026-05-07T12:00:00Z') })

    await store.writeMerged(key, [
      { date: '2026-05-06 09:35:00', open: 101, high: 102, low: 100, close: 101.5, volume: 20 },
      { date: '2026-05-06 09:30:00', open: '100' as unknown as number, high: 101, low: 99, close: 100.5, volume: '10' as unknown as number },
      { date: 'bad', open: null as unknown as number, high: 1, low: 1, close: 1, volume: 1 },
      { date: '2026-05-06 09:35:00', open: 111, high: 112, low: 110, close: 111.5, volume: 30 },
    ])

    const bars = await store.readAll(key)
    expect(bars.map((bar) => [bar.date, bar.open, bar.volume])).toEqual([
      ['2026-05-06 09:30:00', 100, 10],
      ['2026-05-06 09:35:00', 111, 30],
    ])

    await expect(store.readMeta(key)).resolves.toMatchObject({
      provider: 'yfinance',
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      from: '2026-05-06 09:30:00',
      to: '2026-05-06 09:35:00',
      bars: 2,
      updatedAt: '2026-05-07T12:00:00.000Z',
    })
  })

  it('returns an empty array when a partition is missing', async () => {
    const store = new OhlcvCacheStore({ rootDir })
    await expect(store.readAll(key)).resolves.toEqual([])
  })

  it('filters inclusive ranges', () => {
    const rows = [
      { date: '2026-05-06', open: 1, high: 1, low: 1, close: 1, volume: null },
      { date: '2026-05-07', open: 2, high: 2, low: 2, close: 2, volume: null },
      { date: '2026-05-08', open: 3, high: 3, low: 3, close: 3, volume: null },
    ]

    expect(filterRange(rows, { startDate: '2026-05-07', endDate: '2026-05-08' }).map((row) => row.date)).toEqual([
      '2026-05-07',
      '2026-05-08',
    ])
  })
})
