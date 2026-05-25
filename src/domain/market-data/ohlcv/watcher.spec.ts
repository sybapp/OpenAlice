import { describe, expect, it, vi } from 'vitest'
import type { Listener } from '../../../core/listener.js'
import type { ListenerRegistry } from '../../../core/listener-registry.js'
import type { CronEngine, CronJob, CronJobPatch, CronJobCreate } from '../../../task/cron/engine.js'
import type { OhlcvCacheService } from './cache-service.js'
import { createMarketDataWatcher, MARKET_DATA_WATCH_JOB_NAME } from './watcher.js'

function createCronStub(existing: CronJob[] = []) {
  const jobs = [...existing]
  return {
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(() => jobs),
    add: vi.fn(async (params: CronJobCreate) => {
      jobs.push({
        id: 'new-job',
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        payload: params.payload,
        state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
        createdAt: 0,
      })
      return 'new-job'
    }),
    update: vi.fn(async (id: string, patch: CronJobPatch) => {
      const job = jobs.find((item) => item.id === id)
      if (job) Object.assign(job, patch)
    }),
    remove: vi.fn(),
    runNow: vi.fn(),
    get: vi.fn((id: string) => jobs.find((job) => job.id === id)),
  } satisfies CronEngine
}

function createRegistryStub() {
  const listeners = new Map<string, Listener>()
  return {
    register: vi.fn((listener: Listener) => { listeners.set(listener.name, listener) }),
    unregister: vi.fn((name: string) => { listeners.delete(name) }),
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(() => []),
    declareProducer: vi.fn(),
  } as unknown as ListenerRegistry
}

describe('createMarketDataWatcher', () => {
  it('starts a pump and prewarms configured intervals', async () => {
    const cron = createCronStub()
    const registry = createRegistryStub()
    const prefetch = vi.fn().mockResolvedValue({ bars: 1, from: '2026-05-07', to: '2026-05-07' })

    const watcher = createMarketDataWatcher({
      config: {
        enabled: true,
        every: '5m',
        items: [{ asset: 'equity', symbol: 'QQQ', intervals: ['5m', '1h'], lookbackBars: 50 }],
      },
      cronEngine: cron,
      registry,
      cacheService: { prefetch } as unknown as OhlcvCacheService,
      clients: {
        equity: { getHistorical: vi.fn() } as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    await watcher.start()

    expect(cron.add).not.toHaveBeenCalled()
    expect(registry.register).not.toHaveBeenCalled()
    expect(prefetch).toHaveBeenCalledTimes(2)
    expect(prefetch.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      ['equity', 'QQQ', '5m'],
      ['equity', 'QQQ', '1h'],
    ])
  })

  it('updates an existing cron job and no-ops when disabled', async () => {
    const cron = createCronStub([{
      id: 'existing',
      name: MARKET_DATA_WATCH_JOB_NAME,
      enabled: true,
      schedule: { kind: 'every', every: '1m' },
      payload: '',
      state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
      createdAt: 0,
    }])
    const registry = createRegistryStub()
    const prefetch = vi.fn()

    const watcher = createMarketDataWatcher({
      config: { enabled: false, every: '15m', items: [{ asset: 'equity', symbol: 'QQQ', intervals: ['5m'] }] },
      cronEngine: cron,
      registry,
      cacheService: { prefetch } as unknown as OhlcvCacheService,
      clients: {
        equity: { getHistorical: vi.fn() } as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    await watcher.start()
    const result = await watcher.runOnce()

    expect(cron.update).not.toHaveBeenCalled()
    expect(prefetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      enabled: false,
      skipped: true,
      reason: 'disabled',
      itemCount: 1,
      results: [],
    })
  })

  it('continues processing after an item failure', async () => {
    const cron = createCronStub()
    const registry = createRegistryStub()
    const prefetch = vi.fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ bars: 1, from: '2026-05-07', to: '2026-05-07' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const watcher = createMarketDataWatcher({
      config: {
        enabled: true,
        every: '5m',
        items: [
          { asset: 'equity', symbol: 'BAD', intervals: ['5m'] },
          { asset: 'equity', symbol: 'QQQ', intervals: ['5m'] },
        ],
      },
      cronEngine: cron,
      registry,
      cacheService: { prefetch } as unknown as OhlcvCacheService,
      clients: {
        equity: { getHistorical: vi.fn() } as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    const result = await watcher.runOnce()

    expect(prefetch).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalled()
    expect(result.results).toMatchObject([
      { asset: 'equity', symbol: 'BAD', interval: '5m', ok: false, error: 'rate limited' },
      { asset: 'equity', symbol: 'QQQ', interval: '5m', ok: true, bars: 1 },
    ])
    warn.mockRestore()
  })

  it('hot-reads the latest watch config for start and runOnce', async () => {
    const cron = createCronStub()
    const registry = createRegistryStub()
    const prefetch = vi.fn().mockResolvedValue({ bars: 1, from: '2026-05-07', to: '2026-05-07' })
    let currentConfig = {
      enabled: true,
      every: '5m',
      items: [{ asset: 'equity' as const, symbol: 'QQQ', intervals: ['5m'] }],
    }

    const watcher = createMarketDataWatcher({
      config: { enabled: false, every: '1h', items: [] },
      readConfig: async () => currentConfig,
      cronEngine: cron,
      registry,
      cacheService: { prefetch } as unknown as OhlcvCacheService,
      clients: {
        equity: { getHistorical: vi.fn() } as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    await watcher.start()
    expect(cron.add).not.toHaveBeenCalled()
    expect(prefetch.mock.calls.map((call) => call[1])).toEqual(['QQQ'])

    currentConfig = {
      enabled: true,
      every: '15m',
      items: [{ asset: 'equity' as const, symbol: 'AAPL', intervals: ['1h'] }],
    }
    await watcher.runOnce()

    expect(prefetch.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['QQQ', '5m'],
      ['AAPL', '1h'],
    ])
  })
})
