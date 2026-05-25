import type { EventLogEntry } from '../../../core/event-log.js'
import type { Listener } from '../../../core/listener.js'
import type { ListenerRegistry } from '../../../core/listener-registry.js'
import { createPump, type Pump } from '../../../core/pump.js'
import type { CronFirePayload } from '../../../task/cron/engine.js'
import type { CronEngine } from '../../../task/cron/engine.js'
import type { CommodityClientLike, CryptoClientLike, CurrencyClientLike, EquityClientLike } from '../client/types.js'
import type { OhlcvCacheService } from './cache-service.js'
import type { OhlcvWatchConfig, OhlcvWatchItem } from './types.js'

export const MARKET_DATA_WATCH_JOB_NAME = '__market_data_watch__'

export interface MarketDataWatchIntervalResult {
  asset: OhlcvWatchItem['asset']
  symbol: string
  interval: string
  effectiveInterval: string
  provider?: string
  ok: boolean
  bars?: number
  from?: string
  to?: string
  error?: string
}

export interface MarketDataWatchRunResult {
  enabled: boolean
  skipped: boolean
  reason?: 'disabled' | 'already_processing'
  every: string
  itemCount: number
  results: MarketDataWatchIntervalResult[]
  startedAt: string
  finishedAt: string
}

export interface MarketDataWatcher {
  start(): Promise<void>
  stop(): void
  runOnce(): Promise<MarketDataWatchRunResult>
  readonly listener: Listener<'cron.fire'>
}

export function createMarketDataWatcher(deps: {
  config: OhlcvWatchConfig
  readConfig?: () => Promise<OhlcvWatchConfig>
  cronEngine: CronEngine
  registry: ListenerRegistry
  cacheService: OhlcvCacheService
  clients: {
    equity: EquityClientLike
    crypto: CryptoClientLike
    currency: CurrencyClientLike
    commodity: CommodityClientLike
  }
}): MarketDataWatcher {
  const { config, cronEngine, registry, cacheService, clients } = deps
  const readConfig = deps.readConfig ?? (async () => config)
  let processing = false
  let registered = false
  let pump: Pump | null = null

  async function handleFire(entry: EventLogEntry<CronFirePayload>): Promise<void> {
    if (entry.payload.jobName !== MARKET_DATA_WATCH_JOB_NAME) return
    await runOnce()
  }

  async function runOnce(): Promise<MarketDataWatchRunResult> {
    const startedAt = new Date().toISOString()
    const latestConfig = await readConfig()
    if (!latestConfig.enabled) {
      return {
        enabled: false,
        skipped: true,
        reason: 'disabled',
        every: latestConfig.every,
        itemCount: latestConfig.items.length,
        results: [],
        startedAt,
        finishedAt: new Date().toISOString(),
      }
    }
    if (processing) {
      return {
        enabled: latestConfig.enabled,
        skipped: true,
        reason: 'already_processing',
        every: latestConfig.every,
        itemCount: latestConfig.items.length,
        results: [],
        startedAt,
        finishedAt: new Date().toISOString(),
      }
    }
    processing = true
    const results: MarketDataWatchIntervalResult[] = []
    try {
      for (const item of latestConfig.items) {
        results.push(...await prefetchItem(item))
      }
      return {
        enabled: latestConfig.enabled,
        skipped: false,
        every: latestConfig.every,
        itemCount: latestConfig.items.length,
        results,
        startedAt,
        finishedAt: new Date().toISOString(),
      }
    } finally {
      processing = false
    }
  }

  async function prefetchItem(item: OhlcvWatchItem): Promise<MarketDataWatchIntervalResult[]> {
    const results: MarketDataWatchIntervalResult[] = []
    for (const interval of item.intervals) {
      const effectiveInterval = item.asset === 'commodity' ? '1d' : interval
      const params: Record<string, unknown> = {
        symbol: item.symbol,
        interval: effectiveInterval,
        start_date: buildLookbackStart(effectiveInterval, item.lookbackBars ?? 300),
      }
      if (item.provider) params.provider = item.provider

      try {
        let prefetched: { bars: number; from: string; to: string }
        switch (item.asset) {
          case 'equity':
            prefetched = await cacheService.prefetch('equity', item.symbol, effectiveInterval, params, (p) => clients.equity.getHistorical(p) as Promise<Record<string, unknown>[]>)
            break
          case 'crypto':
            prefetched = await cacheService.prefetch('crypto', item.symbol, effectiveInterval, params, (p) => clients.crypto.getHistorical(p) as Promise<Record<string, unknown>[]>)
            break
          case 'currency':
            prefetched = await cacheService.prefetch('currency', item.symbol, effectiveInterval, params, (p) => clients.currency.getHistorical(p) as Promise<Record<string, unknown>[]>)
            break
          case 'commodity':
            prefetched = await cacheService.prefetch('commodity', item.symbol, '1d', params, (p) => clients.commodity.getSpotPrices(p) as Promise<Record<string, unknown>[]>)
            break
        }
        results.push({
          asset: item.asset,
          symbol: item.symbol,
          interval,
          effectiveInterval,
          provider: item.provider,
          ok: true,
          ...prefetched,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({
          asset: item.asset,
          symbol: item.symbol,
          interval,
          effectiveInterval,
          provider: item.provider,
          ok: false,
          error: message,
        })
        console.warn(`market-data-watch: ${item.asset}:${item.symbol}:${interval} failed:`, message)
      }
    }
    return results
  }

  const listener: Listener<'cron.fire'> = {
    name: 'market-data-watch',
    subscribes: 'cron.fire',
    handle: handleFire,
  }

  return {
    listener,
    async start() {
      const latestConfig = await readConfig()
      pump = createPump({
        name: 'market-data-watch',
        every: latestConfig.every,
        enabled: latestConfig.enabled,
        onTick: async () => { await runOnce() },
      })
      pump.start()

      await runOnce()
    },
    stop() {
      pump?.stop()
      pump = null
      if (registered) {
        registry.unregister(listener.name)
        registered = false
      }
    },
    runOnce,
  }
}

function buildLookbackStart(interval: string, bars: number): string {
  const now = new Date()
  const ms = intervalToMs(interval) ?? 86_400_000
  const start = new Date(now.getTime() - ms * bars)
  return start.toISOString().slice(0, 10)
}

function intervalToMs(interval: string): number | null {
  const match = interval.match(/^(\d+)([mhd])$/)
  if (!match) return null
  const n = Number(match[1])
  if (match[2] === 'm') return n * 60_000
  if (match[2] === 'h') return n * 3_600_000
  if (match[2] === 'd') return n * 86_400_000
  return null
}
