import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TradeSetupStore } from './setup-store.js'

describe('TradeSetupStore', () => {
  let root: string
  let store: TradeSetupStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-trade-setup-'))
    store = new TradeSetupStore(join(root, 'setups.json'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns empty list when store file is absent', async () => {
    await expect(store.list()).resolves.toEqual({ count: 0, entries: [] })
  })

  it('creates, filters, and updates setups', async () => {
    const setup = await store.create({
      source: { type: 'market_data_alert', alertRunId: 'run-1' },
      symbol: 'QQQ',
      interval: '5m',
      direction: 'bullish',
      thesis: 'BOS',
      invalidation: 'below low',
      signals: [],
      order: { source: 'mock', aliceId: 'mock|QQQ', action: 'BUY', orderType: 'MKT', totalQuantity: '1' },
    })

    const updated = await store.update(setup.setupId, { status: 'committed', commitHash: 'abc123' })
    const listed = await store.list({ status: 'committed', symbol: 'qqq' })

    expect(setup.setupId).toEqual(expect.any(String))
    expect(updated).toMatchObject({ setupId: setup.setupId, status: 'committed', commitHash: 'abc123' })
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]).toMatchObject({ symbol: 'QQQ', status: 'committed' })
  })
})
