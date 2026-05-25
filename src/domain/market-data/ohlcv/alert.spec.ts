import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorCenter } from '../../../core/connector-center.js'
import { createMemoryNotificationsStore } from '../../../core/notifications-store.js'
import type { Listener } from '../../../core/listener.js'
import type { ListenerRegistry } from '../../../core/listener-registry.js'
import type { CronEngine, CronJob, CronJobCreate, CronJobPatch } from '../../../task/cron/engine.js'
import type { OhlcvCacheService } from './cache-service.js'
import { createMarketDataAlertScheduler, MARKET_DATA_ALERT_JOB_NAME } from './alert.js'

function createCronStub(existing: CronJob[] = []) {
  const jobs = [...existing]
  return {
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(() => jobs),
    add: vi.fn(async (params: CronJobCreate) => {
      jobs.push({
        id: 'alert-job',
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        payload: params.payload,
        state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
        createdAt: 0,
      })
      return 'alert-job'
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
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(() => []),
    declareProducer: vi.fn(),
  } as unknown as ListenerRegistry
}

function createListenerContext() {
  const emitted: Array<{ type: string; payload: unknown }> = []
  return {
    emitted,
    ctx: {
      subscribes: ['cron.fire'],
      emits: ['market_data_alert.triggered', 'market_data_alert.skipped', 'market_data_alert.error', 'agent.work.requested'],
      emit: vi.fn(async (type: string, payload: unknown) => {
        emitted.push({ type, payload })
        return { seq: emitted.length, ts: Date.now(), type, payload }
      }),
      events: {
        read: vi.fn(),
        recent: vi.fn(),
        query: vi.fn(),
        lastSeq: vi.fn(),
      },
    },
  }
}

function candles() {
  return [
    { date: '2026-05-08 09:30:00', open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { date: '2026-05-08 09:35:00', open: 100, high: 101, low: 99, close: 100, volume: 105 },
    { date: '2026-05-08 09:40:00', open: 100, high: 101, low: 99, close: 100, volume: 95 },
    { date: '2026-05-08 09:45:00', open: 105, high: 108, low: 104, close: 107, volume: 300 },
    { date: '2026-05-08 09:50:00', open: 107, high: 109, low: 106, close: 108, volume: 320 },
  ]
}

describe('createMarketDataAlertScheduler', () => {
  let statePath: string
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openalice-market-alert-'))
    statePath = join(tempDir, 'state.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates cron job and registers listener', async () => {
    const cron = createCronStub()
    const registry = createRegistryStub()
    const notificationsStore = createMemoryNotificationsStore()
    const scheduler = createMarketDataAlertScheduler({
      config: { enabled: true, every: '5m', mode: 'deterministic', cooldownMinutes: 60, lookbackBars: 300, items: [] },
      cronEngine: cron,
      registry,
      connectorCenter: new ConnectorCenter({ notificationsStore }),
      cacheService: { getHistorical: vi.fn(async () => []) } as unknown as OhlcvCacheService,
      statePath,
      runsPath: join(tempDir, 'runs.jsonl'),
      feedbackPath: join(tempDir, 'feedback.json'),
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    await scheduler.start()

    expect(cron.add).not.toHaveBeenCalled()
    expect(registry.register).not.toHaveBeenCalled()
  })

  it('returns disabled skipped result without fetching data', async () => {
    const getHistorical = vi.fn()
    const scheduler = createMarketDataAlertScheduler({
      config: {
        enabled: false,
        every: '5m',
        mode: 'deterministic',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [{ asset: 'equity', symbol: 'QQQ', interval: '5m' }],
      },
      cronEngine: createCronStub(),
      registry: createRegistryStub(),
      connectorCenter: new ConnectorCenter({ notificationsStore: createMemoryNotificationsStore() }),
      cacheService: { getHistorical } as unknown as OhlcvCacheService,
      statePath,
      runsPath: join(tempDir, 'runs.jsonl'),
      feedbackPath: join(tempDir, 'feedback.json'),
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    const result = await scheduler.runOnce()

    expect(result).toMatchObject({ enabled: false, skipped: true, reason: 'disabled', itemCount: 1 })
    expect(getHistorical).not.toHaveBeenCalled()
  })

  it('triggers deterministic notification for new volume-price signal and dedupes repeat runs', async () => {
    const notificationsStore = createMemoryNotificationsStore()
    const scheduler = createMarketDataAlertScheduler({
      config: {
        enabled: true,
        every: '5m',
        mode: 'deterministic',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [{ asset: 'equity', symbol: 'QQQ', interval: '5m', thresholds: { maxSignalAgeBars: 10 } }],
      },
      cronEngine: createCronStub(),
      registry: createRegistryStub(),
      connectorCenter: new ConnectorCenter({ notificationsStore }),
      cacheService: { getHistorical: vi.fn(async () => candles()) } as unknown as OhlcvCacheService,
      statePath,
      runsPath: join(tempDir, 'runs.jsonl'),
      feedbackPath: join(tempDir, 'feedback.json'),
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    const first = await scheduler.runOnce()
    const second = await scheduler.runOnce()
    const { entries } = await notificationsStore.read()

    expect(first.results[0]).toMatchObject({ ok: true, notified: true, taskRequested: false })
    expect(first.results[0].signals.length).toBeGreaterThan(0)
    expect(second.results[0]).toMatchObject({ ok: true, skipped: true, reason: 'no_new_signals' })
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe('task')
  })

  it('maps new technical-analysis signal families into alert kinds', async () => {
    const notificationsStore = createMemoryNotificationsStore()
    const boosted = candles()
    boosted.push(
      { date: '2026-05-08 09:55:00', open: 108, high: 110, low: 107, close: 109, volume: 100 },
      { date: '2026-05-08 10:00:00', open: 109, high: 116, low: 108, close: 115, volume: 500 },
    )
    const scheduler = createMarketDataAlertScheduler({
      config: {
        enabled: true,
        every: '5m',
        mode: 'deterministic',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [{
          asset: 'equity',
          symbol: 'QQQ',
          interval: '5m',
          thresholds: { maxSignalAgeBars: 10 },
          options: {
            internalLookback: 1,
            swingLookback: 1,
            volumeProfile: { enabled: true, mode: 'rolling', lookback: 20, bins: 40 },
            unusualVolume: { enabled: true, baselineLookback: 3, zScoreThreshold: 0.5, rvolThreshold: 1.1 },
            vwapDeviation: { enabled: true, bandLookback: 3, stdDevMultiplier: 0.8, signalEnabled: true },
          },
        }],
      },
      cronEngine: createCronStub(),
      registry: createRegistryStub(),
      connectorCenter: new ConnectorCenter({ notificationsStore }),
      cacheService: { getHistorical: vi.fn(async () => boosted) } as unknown as OhlcvCacheService,
      statePath,
      runsPath: join(tempDir, 'runs.jsonl'),
      feedbackPath: join(tempDir, 'feedback.json'),
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    const result = await scheduler.runOnce()
    const kinds = result.results[0].signals.map((signal) => signal.kind)

    expect(result.results[0]).toMatchObject({ ok: true, notified: true })
    expect(kinds).toContain('unusual_volume')
    expect(kinds.some((kind) => kind === 'vp_level' || kind === 'vwap_deviation')).toBe(true)
  })

  it('both mode emits agent.work.requested and triggered event when invoked by cron listener', async () => {
    const notificationsStore = createMemoryNotificationsStore()
    const { ctx, emitted } = createListenerContext()
    const scheduler = createMarketDataAlertScheduler({
      config: {
        enabled: true,
        every: '5m',
        mode: 'both',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [{ asset: 'equity', symbol: 'QQQ', interval: '5m', thresholds: { maxSignalAgeBars: 10 } }],
      },
      cronEngine: createCronStub(),
      registry: createRegistryStub(),
      connectorCenter: new ConnectorCenter({ notificationsStore }),
      cacheService: { getHistorical: vi.fn(async () => candles()) } as unknown as OhlcvCacheService,
      statePath,
      runsPath: join(tempDir, 'runs.jsonl'),
      feedbackPath: join(tempDir, 'feedback.json'),
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    await scheduler.listener.handle(
      { seq: 1, ts: Date.now(), type: 'cron.fire', payload: { jobId: 'j', jobName: MARKET_DATA_ALERT_JOB_NAME, payload: '' } },
      ctx as never,
    )

    expect(emitted.map((entry) => entry.type)).toContain('agent.work.requested')
    const task = emitted.find((entry) => entry.type === 'agent.work.requested')?.payload as any
    expect(task).toMatchObject({ source: 'task', prompt: expect.stringContaining('Analyze this market-data alert for QQQ 5m') })
  })

  it('manual run uses injected task requester for agent mode', async () => {
    const requestTask = vi.fn()
    const scheduler = createMarketDataAlertScheduler({
      config: {
        enabled: true,
        every: '5m',
        mode: 'agent',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [{ asset: 'equity', symbol: 'QQQ', interval: '5m', thresholds: { maxSignalAgeBars: 10 } }],
      },
      cronEngine: createCronStub(),
      registry: createRegistryStub(),
      connectorCenter: new ConnectorCenter({ notificationsStore: createMemoryNotificationsStore() }),
      cacheService: { getHistorical: vi.fn(async () => candles()) } as unknown as OhlcvCacheService,
      statePath,
      runsPath: join(tempDir, 'runs.jsonl'),
      feedbackPath: join(tempDir, 'feedback.json'),
      requestTask,
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    const result = await scheduler.runOnce()

    expect(result.results[0]).toMatchObject({ ok: true, notified: false, taskRequested: true })
    expect(requestTask).toHaveBeenCalledWith(expect.stringContaining('Analyze this market-data alert for QQQ 5m'))
  })

  it('persists item-level alert run history', async () => {
    const runsPath = join(tempDir, 'runs.jsonl')
    const scheduler = createMarketDataAlertScheduler({
      config: {
        enabled: true,
        every: '5m',
        mode: 'deterministic',
        cooldownMinutes: 60,
        lookbackBars: 300,
        items: [{ asset: 'equity', symbol: 'QQQ', interval: '5m', thresholds: { maxSignalAgeBars: 10 } }],
      },
      cronEngine: createCronStub(),
      registry: createRegistryStub(),
      connectorCenter: new ConnectorCenter({ notificationsStore: createMemoryNotificationsStore() }),
      cacheService: { getHistorical: vi.fn(async () => candles()) } as unknown as OhlcvCacheService,
      statePath,
      runsPath,
      feedbackPath: join(tempDir, 'feedback.json'),
      clients: {
        equity: {} as never,
        crypto: {} as never,
        currency: {} as never,
        commodity: {} as never,
      },
    })

    await scheduler.runOnce()

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(runsPath, 'utf-8'))
    const record = JSON.parse(raw.trim())
    expect(record).toMatchObject({
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      status: 'triggered',
      notified: true,
    })
    expect(record.runId).toEqual(expect.any(String))
    expect(record.signals.length).toBeGreaterThan(0)
  })
})
