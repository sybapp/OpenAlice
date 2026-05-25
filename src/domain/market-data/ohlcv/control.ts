import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { readMarketDataConfig } from '../../../core/config.js'
import type {
  MarketDataAlertItem,
  MarketDataAlertMode,
  MarketDataAlertRunStatus,
  OhlcvAssetClass,
  OhlcvWatchItem,
} from './types.js'

export type MarketDataConfig = Awaited<ReturnType<typeof readMarketDataConfig>>

export interface AddMarketDataWatchInput {
  asset: OhlcvAssetClass
  symbol: string
  intervals: string[]
  provider?: string
  lookbackBars: number
  enableWatch: boolean
}

export interface RemoveMarketDataWatchInput {
  asset: OhlcvAssetClass
  symbol: string
  provider?: string
  intervals?: string[]
}

export interface SetMarketDataWatchEnabledInput {
  enabled: boolean
  every?: string
}

export interface AddMarketDataAlertInput {
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider?: string
  enabled: boolean
  mode?: MarketDataAlertMode
  lookbackBars: number
  cooldownMinutes?: number
  maxSignalAgeBars: number
  minVolumeScore?: number
  options?: Record<string, unknown>
  enableAlerts: boolean
  ensureWatch: boolean
}

export interface RemoveMarketDataAlertInput {
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider?: string
}

export interface SetMarketDataAlertsEnabledInput {
  enabled: boolean
  every?: string
  mode?: MarketDataAlertMode
}

export interface ListMarketDataAlertRunsInput {
  limit?: number
  asset?: OhlcvAssetClass
  symbol?: string
  interval?: string
  status?: MarketDataAlertRunStatus
}

export interface OhlcvCacheStatusInput {
  cacheDir: string
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider: string
}

export function listMarketDataWatch(config: MarketDataConfig) {
  return {
    enabled: config.watch.enabled,
    every: config.watch.every,
    count: config.watch.items.length,
    items: config.watch.items.map((item) => ({
      asset: item.asset,
      symbol: item.symbol,
      intervals: item.intervals,
      provider: item.provider ?? config.providers[item.asset] ?? null,
      lookbackBars: item.lookbackBars ?? 300,
    })),
  }
}

export async function listMarketDataWatchWithCache(config: MarketDataConfig) {
  const base = listMarketDataWatch(config)
  return {
    ...base,
    items: await Promise.all(config.watch.items.map(async (item) => {
      const provider = item.provider ?? config.providers[item.asset] ?? 'default'
      return {
        asset: item.asset,
        symbol: item.symbol,
        intervals: item.intervals,
        provider,
        lookbackBars: item.lookbackBars ?? 300,
        cache: await Promise.all(item.intervals.map(async (interval) => (
          await readOhlcvCacheStatus({
            cacheDir: config.ohlcvCache.dir,
            asset: item.asset,
            symbol: item.symbol,
            interval: item.asset === 'commodity' ? '1d' : interval,
            provider,
          })
        ))),
      }
    })),
  }
}

export function addMarketDataWatch(config: MarketDataConfig, input: AddMarketDataWatchInput) {
  const normalizedSymbol = input.symbol.trim()
  const normalizedProvider = normalizeOptional(input.provider)
  const normalizedIntervals = uniqueNonEmpty(input.intervals)
  const existingIndex = config.watch.items.findIndex((item) =>
    matchesWatchItem(item, input.asset, normalizedSymbol, normalizedProvider, config.providers[input.asset])
  )

  let action: 'added' | 'updated' = 'added'
  const items = [...config.watch.items]
  if (existingIndex >= 0) {
    action = 'updated'
    const existing = items[existingIndex]
    items[existingIndex] = {
      ...existing,
      intervals: uniqueNonEmpty([...existing.intervals, ...normalizedIntervals]),
      ...(normalizedProvider ? { provider: normalizedProvider } : {}),
      lookbackBars: input.lookbackBars,
    }
  } else {
    items.push({
      asset: input.asset,
      symbol: normalizedSymbol,
      intervals: normalizedIntervals,
      ...(normalizedProvider ? { provider: normalizedProvider } : {}),
      lookbackBars: input.lookbackBars,
    })
  }

  const next = {
    ...config,
    watch: {
      ...config.watch,
      enabled: input.enableWatch ? true : config.watch.enabled,
      items,
    },
  }

  return {
    next,
    result: {
      action,
      enabled: next.watch.enabled,
      every: next.watch.every,
      item: items[existingIndex >= 0 ? existingIndex : items.length - 1],
      count: next.watch.items.length,
    },
  }
}

export function removeMarketDataWatch(config: MarketDataConfig, input: RemoveMarketDataWatchInput) {
  const normalizedSymbol = input.symbol.trim()
  const normalizedProvider = normalizeOptional(input.provider)
  const removeIntervals = input.intervals ? new Set(uniqueNonEmpty(input.intervals)) : null
  let removedItem = false
  const removedIntervals: string[] = []
  const items: OhlcvWatchItem[] = []

  for (const item of config.watch.items) {
    const matches = matchesWatchItem(item, input.asset, normalizedSymbol, normalizedProvider, config.providers[input.asset])
    if (!matches) {
      items.push(item)
      continue
    }

    if (!removeIntervals) {
      removedItem = true
      continue
    }

    const kept = item.intervals.filter((interval) => {
      const shouldRemove = removeIntervals.has(interval)
      if (shouldRemove) removedIntervals.push(interval)
      return !shouldRemove
    })
    if (kept.length > 0) {
      items.push({ ...item, intervals: kept })
    } else {
      removedItem = true
    }
  }

  const next = {
    ...config,
    watch: { ...config.watch, items },
  }

  return {
    next,
    result: {
      removed: removedItem || removedIntervals.length > 0,
      removedItem,
      removedIntervals,
      count: next.watch.items.length,
      enabled: next.watch.enabled,
    },
  }
}

export function setMarketDataWatchEnabled(config: MarketDataConfig, input: SetMarketDataWatchEnabledInput) {
  const next = {
    ...config,
    watch: {
      ...config.watch,
      enabled: input.enabled,
      ...(input.every ? { every: input.every } : {}),
    },
  }

  return {
    next,
    result: {
      enabled: next.watch.enabled,
      every: next.watch.every,
      count: next.watch.items.length,
    },
  }
}

export function listMarketDataAlerts(config: MarketDataConfig) {
  return {
    enabled: config.alerts.enabled,
    every: config.alerts.every,
    mode: config.alerts.mode,
    cooldownMinutes: config.alerts.cooldownMinutes,
    lookbackBars: config.alerts.lookbackBars,
    count: config.alerts.items.length,
    items: config.alerts.items.map((item) => ({
      asset: item.asset,
      symbol: item.symbol,
      interval: item.asset === 'commodity' ? '1d' : item.interval,
      provider: item.provider ?? config.providers[item.asset] ?? null,
      enabled: item.enabled ?? true,
      mode: item.mode ?? config.alerts.mode,
      cooldownMinutes: item.cooldownMinutes ?? config.alerts.cooldownMinutes,
      lookbackBars: item.lookbackBars ?? config.alerts.lookbackBars,
      thresholds: item.thresholds ?? null,
      options: item.options ?? {},
    })),
  }
}

export function addMarketDataAlert(config: MarketDataConfig, input: AddMarketDataAlertInput) {
  const normalizedSymbol = input.symbol.trim()
  const normalizedProvider = normalizeOptional(input.provider)
  const normalizedInterval = input.asset === 'commodity' ? '1d' : input.interval.trim()
  const item: MarketDataAlertItem = {
    asset: input.asset,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    ...(normalizedProvider ? { provider: normalizedProvider } : {}),
    enabled: input.enabled,
    ...(input.mode ? { mode: input.mode } : {}),
    lookbackBars: input.lookbackBars,
    ...(input.cooldownMinutes == null ? {} : { cooldownMinutes: input.cooldownMinutes }),
    ...(input.options ? { options: input.options } : {}),
    thresholds: {
      maxSignalAgeBars: input.maxSignalAgeBars,
      ...(input.minVolumeScore == null ? {} : { minVolumeScore: input.minVolumeScore }),
    },
  }

  const existingIndex = config.alerts.items.findIndex((existing) =>
    matchesAlertItem(existing, input.asset, normalizedSymbol, normalizedInterval, normalizedProvider, config.providers[input.asset])
  )
  const alertItems = [...config.alerts.items]
  const action: 'added' | 'updated' = existingIndex >= 0 ? 'updated' : 'added'
  if (existingIndex >= 0) {
    alertItems[existingIndex] = { ...alertItems[existingIndex], ...item }
  } else {
    alertItems.push(item)
  }

  const watchItems = input.ensureWatch
    ? upsertWatchItem(config.watch.items, {
        asset: input.asset,
        symbol: normalizedSymbol,
        intervals: [normalizedInterval],
        ...(normalizedProvider ? { provider: normalizedProvider } : {}),
        lookbackBars: input.lookbackBars,
      }, config.providers[input.asset])
    : config.watch.items

  const next = {
    ...config,
    watch: input.ensureWatch ? {
      ...config.watch,
      enabled: true,
      items: watchItems,
    } : config.watch,
    alerts: {
      ...config.alerts,
      enabled: input.enableAlerts ? true : config.alerts.enabled,
      items: alertItems,
    },
  }

  return {
    next,
    result: {
      action,
      enabled: next.alerts.enabled,
      every: next.alerts.every,
      item: alertItems[existingIndex >= 0 ? existingIndex : alertItems.length - 1],
      count: next.alerts.items.length,
      watchEnsured: input.ensureWatch,
    },
  }
}

export function removeMarketDataAlert(config: MarketDataConfig, input: RemoveMarketDataAlertInput) {
  const normalizedInterval = input.asset === 'commodity' ? '1d' : input.interval.trim()
  const normalizedProvider = normalizeOptional(input.provider)
  const before = config.alerts.items.length
  const items = config.alerts.items.filter((item) =>
    !matchesAlertItem(item, input.asset, input.symbol.trim(), normalizedInterval, normalizedProvider, config.providers[input.asset])
  )
  const next = {
    ...config,
    alerts: { ...config.alerts, items },
  }

  return {
    next,
    result: {
      removed: items.length < before,
      count: next.alerts.items.length,
      enabled: next.alerts.enabled,
    },
  }
}

export function setMarketDataAlertsEnabled(config: MarketDataConfig, input: SetMarketDataAlertsEnabledInput) {
  const next = {
    ...config,
    alerts: {
      ...config.alerts,
      enabled: input.enabled,
      ...(input.every ? { every: input.every } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    },
  }

  return {
    next,
    result: {
      enabled: next.alerts.enabled,
      every: next.alerts.every,
      mode: next.alerts.mode,
      count: next.alerts.items.length,
    },
  }
}

export async function readOhlcvCacheStatus(params: OhlcvCacheStatusInput) {
  const cachePath = join(
    params.cacheDir,
    safeSegment(params.provider),
    safeSegment(params.asset),
    safeSegment(params.symbol),
    safeSegment(params.interval),
  )
  const metaPath = join(cachePath, 'meta.json')

  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, unknown>
    return {
      interval: params.interval,
      exists: true,
      healthy: true,
      cachePath,
      metaPath,
      provider: params.provider,
      asset: params.asset,
      symbol: params.symbol,
      bars: meta.bars ?? 0,
      from: meta.from ?? '',
      to: meta.to ?? '',
      updatedAt: meta.updatedAt ?? null,
    }
  } catch (error) {
    if (isENOENT(error)) {
      return {
        interval: params.interval,
        exists: false,
        healthy: false,
        cachePath,
        metaPath,
        provider: params.provider,
        asset: params.asset,
        symbol: params.symbol,
        bars: 0,
        from: '',
        to: '',
        updatedAt: null,
      }
    }
    return {
      interval: params.interval,
      exists: true,
      healthy: false,
      cachePath,
      metaPath,
      provider: params.provider,
      asset: params.asset,
      symbol: params.symbol,
      bars: 0,
      from: '',
      to: '',
      updatedAt: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function readMarketDataAlertStateSummary(path = 'data/cache/market-data-alerts/state.json') {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { seenSignals?: Record<string, number> }
    const entries = Object.entries(raw.seenSignals ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([key, ts]) => ({ key, ts, at: new Date(ts).toISOString() }))
    return {
      exists: true,
      seenSignals: Object.keys(raw.seenSignals ?? {}).length,
      recent: entries,
    }
  } catch (error) {
    if (isENOENT(error)) {
      return { exists: false, seenSignals: 0, recent: [] }
    }
    return {
      exists: true,
      seenSignals: 0,
      recent: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function providerFor(config: MarketDataConfig, asset: OhlcvAssetClass, provider?: string | null): string {
  return normalizeOptional(provider ?? undefined) ?? config.providers[asset] ?? 'default'
}

export function normalizeAlertRunsQuery(input: ListMarketDataAlertRunsInput = {}) {
  return {
    ...(input.limit ? { limit: Math.max(1, Math.min(500, Math.trunc(input.limit))) } : {}),
    ...(input.asset ? { asset: input.asset } : {}),
    ...(input.symbol?.trim() ? { symbol: input.symbol.trim() } : {}),
    ...(input.interval?.trim() ? { interval: input.interval.trim() } : {}),
    ...(input.status ? { status: input.status } : {}),
  }
}

export function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

export function matchesWatchItem(
  item: OhlcvWatchItem,
  asset: OhlcvAssetClass,
  symbol: string,
  provider: string | undefined,
  defaultProvider: string | undefined,
): boolean {
  const requestedProvider = provider ?? defaultProvider ?? ''
  const itemProvider = item.provider ?? defaultProvider ?? ''
  return item.asset === asset &&
    item.symbol.toUpperCase() === symbol.toUpperCase() &&
    itemProvider === requestedProvider
}

export function matchesAlertItem(
  item: MarketDataAlertItem,
  asset: OhlcvAssetClass,
  symbol: string,
  interval: string,
  provider: string | undefined,
  defaultProvider: string | undefined,
): boolean {
  const requestedProvider = provider ?? defaultProvider ?? ''
  const itemProvider = item.provider ?? defaultProvider ?? ''
  return item.asset === asset &&
    item.symbol.toUpperCase() === symbol.toUpperCase() &&
    (item.asset === 'commodity' ? '1d' : item.interval) === interval &&
    itemProvider === requestedProvider
}

export function upsertWatchItem(items: OhlcvWatchItem[], incoming: OhlcvWatchItem, defaultProvider: string | undefined): OhlcvWatchItem[] {
  const existingIndex = items.findIndex((item) =>
    matchesWatchItem(item, incoming.asset, incoming.symbol, incoming.provider, defaultProvider)
  )
  if (existingIndex < 0) return [...items, incoming]
  return items.map((item, index) => index === existingIndex
    ? {
        ...item,
        intervals: uniqueNonEmpty([...item.intervals, ...incoming.intervals]),
        ...(incoming.provider ? { provider: incoming.provider } : {}),
        lookbackBars: incoming.lookbackBars ?? item.lookbackBars,
      }
    : item)
}

export function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.=-]+/g, '_') || '_'
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
