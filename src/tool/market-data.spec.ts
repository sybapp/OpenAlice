import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarketDataTools } from './market-data.js'
import { MarketDataAlertRunStore, setMarketDataAlertRunStoreDefaults } from '@/domain/market-data/ohlcv'

const mocks = vi.hoisted(() => ({
  writeConfigSection: vi.fn(async (_section: string, data: unknown) => data),
  marketDataConfig: undefined as any,
}))

vi.mock('@/core/config', () => ({
  readMarketDataConfig: vi.fn(async () => mocks.marketDataConfig),
  writeConfigSection: mocks.writeConfigSection,
}))

describe('market-data tools', () => {
  let cacheRoot: string

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'openalice-market-data-tools-'))
    mocks.marketDataConfig = {
      enabled: true,
      apiUrl: 'http://localhost:6900',
      providers: { equity: 'twelvedata', crypto: 'yfinance', currency: 'yfinance', commodity: 'fmp' },
      providerKeys: {},
      ohlcvCache: { enabled: true, dir: cacheRoot, maxGapRequests: 4, writeClosedOnly: true },
      watch: {
        enabled: true,
        every: '5m',
        items: [
          { asset: 'equity', symbol: 'QQQ', intervals: ['5m', '1h'], lookbackBars: 200 },
          { asset: 'crypto', symbol: 'BTCUSD', intervals: ['1h'], provider: 'twelvedata' },
        ],
      },
      alerts: {
        enabled: true,
        every: '5m',
        mode: 'deterministic',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [
          { asset: 'equity', symbol: 'QQQ', interval: '5m', mode: 'both', thresholds: { maxSignalAgeBars: 2 } },
        ],
      },
      backend: 'typebb-sdk',
    }
    mocks.writeConfigSection.mockClear()
  })

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true })
    setMarketDataAlertRunStoreDefaults({})
  })

  it('listMarketDataWatch returns configured OHLCV watch items with cache status', async () => {
    const metaDir = join(cacheRoot, 'twelvedata', 'equity', 'QQQ', '5m')
    await mkdir(metaDir, { recursive: true })
    await writeFile(join(metaDir, 'meta.json'), JSON.stringify({
      bars: 123,
      from: '2026-05-01 09:30:00',
      to: '2026-05-07 16:00:00',
      updatedAt: '2026-05-08T00:00:00.000Z',
    }))
    const tools = createMarketDataTools()

    const result = await tools.listMarketDataWatch.execute!(
      {},
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result).toMatchObject({
      enabled: true,
      every: '5m',
      count: 2,
      items: [
        {
          asset: 'equity',
          symbol: 'QQQ',
          intervals: ['5m', '1h'],
          provider: 'twelvedata',
          lookbackBars: 200,
          cache: [
            {
              interval: '5m',
              exists: true,
              healthy: true,
              bars: 123,
              from: '2026-05-01 09:30:00',
              to: '2026-05-07 16:00:00',
              updatedAt: '2026-05-08T00:00:00.000Z',
            },
            {
              interval: '1h',
              exists: false,
              healthy: false,
              bars: 0,
              from: '',
              to: '',
              updatedAt: null,
            },
          ],
        },
        {
          asset: 'crypto',
          symbol: 'BTCUSD',
          intervals: ['1h'],
          provider: 'twelvedata',
          lookbackBars: 300,
          cache: [{
            interval: '1h',
            exists: false,
            healthy: false,
            bars: 0,
            from: '',
            to: '',
            updatedAt: null,
          }],
        },
      ],
    })
  })

  it('addMarketDataWatch upserts matching items and enables watch', async () => {
    const tools = createMarketDataTools()

    const result = await tools.addMarketDataWatch.execute!(
      { asset: 'equity', symbol: 'qqq', intervals: ['15m', '5m'], lookbackBars: 400, enableWatch: true },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result.action).toBe('updated')
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('marketData', expect.objectContaining({
      watch: expect.objectContaining({
        enabled: true,
        items: [
          { asset: 'equity', symbol: 'QQQ', intervals: ['5m', '1h', '15m'], lookbackBars: 400 },
          { asset: 'crypto', symbol: 'BTCUSD', intervals: ['1h'], provider: 'twelvedata' },
        ],
      }),
    }))
  })

  it('removeMarketDataWatch removes selected intervals or the whole item', async () => {
    const tools = createMarketDataTools()

    const intervalResult = await tools.removeMarketDataWatch.execute!(
      { asset: 'equity', symbol: 'QQQ', intervals: ['1h'] },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(intervalResult).toMatchObject({ removed: true, removedItem: false, removedIntervals: ['1h'] })
    expect(mocks.writeConfigSection).toHaveBeenLastCalledWith('marketData', expect.objectContaining({
      watch: expect.objectContaining({
        items: [
          { asset: 'equity', symbol: 'QQQ', intervals: ['5m'], lookbackBars: 200 },
          { asset: 'crypto', symbol: 'BTCUSD', intervals: ['1h'], provider: 'twelvedata' },
        ],
      }),
    }))

    mocks.marketDataConfig = mocks.writeConfigSection.mock.calls.at(-1)![1]
    const itemResult = await tools.removeMarketDataWatch.execute!(
      { asset: 'crypto', symbol: 'BTCUSD', provider: 'twelvedata' },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(itemResult).toMatchObject({ removed: true, removedItem: true })
    expect(mocks.writeConfigSection).toHaveBeenLastCalledWith('marketData', expect.objectContaining({
      watch: expect.objectContaining({
        items: [{ asset: 'equity', symbol: 'QQQ', intervals: ['5m'], lookbackBars: 200 }],
      }),
    }))
  })

  it('setMarketDataWatchEnabled updates enabled and schedule', async () => {
    const tools = createMarketDataTools()

    const result = await tools.setMarketDataWatchEnabled.execute!(
      { enabled: false, every: '15m' },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result).toMatchObject({ enabled: false, every: '15m', count: 2 })
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('marketData', expect.objectContaining({
      watch: expect.objectContaining({ enabled: false, every: '15m' }),
    }))
  })

  it('runMarketDataWatchNow delegates to the runtime watcher', async () => {
    const runWatchNow = vi.fn(async () => ({
      enabled: true,
      skipped: false,
      every: '5m',
      itemCount: 1,
      results: [{ asset: 'equity' as const, symbol: 'QQQ', interval: '5m', effectiveInterval: '5m', ok: true, bars: 200 }],
      startedAt: '2026-05-08T00:00:00.000Z',
      finishedAt: '2026-05-08T00:00:01.000Z',
    }))
    const tools = createMarketDataTools({ runWatchNow })

    const result = await tools.runMarketDataWatchNow.execute!(
      {},
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(runWatchNow).toHaveBeenCalled()
    expect(result.results[0]).toMatchObject({ symbol: 'QQQ', ok: true, bars: 200 })
  })

  it('listMarketDataAlerts returns configured alerts', async () => {
    const tools = createMarketDataTools()

    const result = await tools.listMarketDataAlerts.execute!(
      {},
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result).toEqual({
      enabled: true,
      every: '5m',
      mode: 'deterministic',
      cooldownMinutes: 60,
      lookbackBars: 300,
      count: 1,
      items: [{
        asset: 'equity',
        symbol: 'QQQ',
        interval: '5m',
        provider: 'twelvedata',
        enabled: true,
        mode: 'both',
        cooldownMinutes: 60,
        lookbackBars: 300,
        options: {},
        thresholds: { maxSignalAgeBars: 2 },
      }],
    })
  })

  it('addMarketDataAlert upserts alerts and ensures matching watch item', async () => {
    const tools = createMarketDataTools()

    const result = await tools.addMarketDataAlert.execute!(
      {
        asset: 'equity',
        symbol: 'AAPL',
        interval: '15m',
        enabled: true,
        mode: 'both',
        lookbackBars: 400,
        cooldownMinutes: 30,
        maxSignalAgeBars: 4,
        minVolumeScore: 1,
        enableAlerts: true,
        ensureWatch: true,
      },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result).toMatchObject({ action: 'added', enabled: true, count: 2, watchEnsured: true })
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('marketData', expect.objectContaining({
      watch: expect.objectContaining({
        enabled: true,
        items: expect.arrayContaining([
          { asset: 'equity', symbol: 'AAPL', intervals: ['15m'], lookbackBars: 400 },
        ]),
      }),
      alerts: expect.objectContaining({
        enabled: true,
        items: expect.arrayContaining([
          expect.objectContaining({
            asset: 'equity',
            symbol: 'AAPL',
            interval: '15m',
            mode: 'both',
            cooldownMinutes: 30,
            lookbackBars: 400,
            thresholds: { maxSignalAgeBars: 4, minVolumeScore: 1 },
          }),
        ]),
      }),
    }))
  })

  it('removeMarketDataAlert removes a matching alert item', async () => {
    const tools = createMarketDataTools()

    const result = await tools.removeMarketDataAlert.execute!(
      { asset: 'equity', symbol: 'QQQ', interval: '5m' },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result).toMatchObject({ removed: true, count: 0, enabled: true })
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('marketData', expect.objectContaining({
      alerts: expect.objectContaining({ items: [] }),
    }))
  })

  it('setMarketDataAlertsEnabled updates enabled, schedule, and mode', async () => {
    const tools = createMarketDataTools()

    const result = await tools.setMarketDataAlertsEnabled.execute!(
      { enabled: false, every: '15m', mode: 'agent' },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(result).toMatchObject({ enabled: false, every: '15m', mode: 'agent', count: 1 })
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('marketData', expect.objectContaining({
      alerts: expect.objectContaining({ enabled: false, every: '15m', mode: 'agent' }),
    }))
  })

  it('runMarketDataAlertsNow delegates to the runtime alert scheduler', async () => {
    const runAlertsNow = vi.fn(async () => ({
      enabled: true,
      skipped: false,
      every: '5m',
      itemCount: 1,
      results: [{
        asset: 'equity' as const,
        symbol: 'QQQ',
        interval: '5m',
        mode: 'both' as const,
        ok: true,
        signals: [{ id: 'structure:x', kind: 'structure' as const, label: 'BOS', index: 10, time: 't', message: 'BOS' }],
        notified: true,
        taskRequested: true,
      }],
      startedAt: '2026-05-08T00:00:00.000Z',
      finishedAt: '2026-05-08T00:00:01.000Z',
    }))
    const tools = createMarketDataTools({ runAlertsNow })

    const result = await tools.runMarketDataAlertsNow.execute!(
      {},
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(runAlertsNow).toHaveBeenCalled()
    expect(result.results[0]).toMatchObject({ symbol: 'QQQ', notified: true, taskRequested: true })
  })

  it('lists alert runs and records feedback', async () => {
    const runsPath = join(cacheRoot, 'runs.jsonl')
    const feedbackPath = join(cacheRoot, 'feedback.json')
    setMarketDataAlertRunStoreDefaults({ runsPath, feedbackPath })
    const store = new MarketDataAlertRunStore(runsPath, feedbackPath)
    const [record] = await store.append([{
      startedAt: '2026-05-08T00:00:00.000Z',
      finishedAt: '2026-05-08T00:00:01.000Z',
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      mode: 'deterministic',
      status: 'triggered',
      signals: [],
      notified: true,
      taskRequested: false,
      summary: 'QQQ triggered',
    }])
    const tools = createMarketDataTools()

    const listed = await tools.listMarketDataAlertRuns.execute!(
      { limit: 10, symbol: 'qqq' },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any
    const feedback = await tools.recordMarketDataAlertFeedback.execute!(
      { runId: record.runId, rating: 'useful', note: 'valid break' },
      { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any },
    ) as any

    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]).toMatchObject({ runId: record.runId, symbol: 'QQQ' })
    expect(feedback).toMatchObject({ ok: true, runId: record.runId, feedback: { rating: 'useful', note: 'valid break' } })
  })
})
