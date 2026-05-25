import type { CommodityClientLike, CryptoClientLike, CurrencyClientLike, EquityClientLike } from '../client/types.js'
import type { OhlcvAssetClass, OhlcvBar, OhlcvCacheConfig, OhlcvPartitionKey, OhlcvRange } from './types.js'
import { filterRange, OhlcvCacheStore } from './store.js'

type HistoricalFetcher = (params: Record<string, unknown>) => Promise<Record<string, unknown>[]>

export interface OhlcvCacheServiceOptions {
  store: OhlcvCacheStore
  config: OhlcvCacheConfig
  providers: Record<OhlcvAssetClass, string | undefined>
  now?: () => Date
}

export class OhlcvCacheService {
  private readonly store: OhlcvCacheStore
  private readonly config: OhlcvCacheConfig
  private readonly providers: Record<OhlcvAssetClass, string | undefined>
  private readonly now: () => Date

  constructor(options: OhlcvCacheServiceOptions) {
    this.store = options.store
    this.config = options.config
    this.providers = options.providers
    this.now = options.now ?? (() => new Date())
  }

  async getHistorical(
    asset: OhlcvAssetClass,
    params: Record<string, unknown>,
    fetcher: HistoricalFetcher,
  ): Promise<Record<string, unknown>[]> {
    if (!this.config.enabled) return fetcher(params)

    const symbol = String(params.symbol ?? '').trim()
    const interval = String(params.interval ?? (asset === 'commodity' ? '1d' : '1d'))
    if (!symbol) return fetcher(params)

    const provider = String(params.provider ?? this.providers[asset] ?? 'default')
    const key: OhlcvPartitionKey = { provider, asset, symbol, interval }
    const range = rangeFromParams(params)
    let allCached = await this.store.readAll(key)
    if (rangeSatisfied(allCached, range, interval, this.now())) return filterRange(allCached, range)

    const requests = buildGapRequests(params, allCached, range, interval, this.now(), this.config.maxGapRequests)
    if (requests.length === 0) requests.push(params)

    let lastFetched: Record<string, unknown>[] = []
    for (const request of requests) {
      try {
        lastFetched = await fetcher(request)
      } catch (error) {
        if (allCached.length > 0) break
        throw error
      }
      const barsToWrite = this.config.writeClosedOnly
        ? filterClosedBars(lastFetched, interval, this.now())
        : normalizeFetched(lastFetched)
      if (barsToWrite.length > 0) {
        allCached = await this.store.writeMerged(key, barsToWrite)
      }
    }

    const cachedAfterFetch = filterRange(allCached, range)
    if (cachedAfterFetch.length > 0) return cachedAfterFetch
    return lastFetched
  }

  async prefetch(
    asset: OhlcvAssetClass,
    symbol: string,
    interval: string,
    params: Record<string, unknown>,
    fetcher: HistoricalFetcher,
  ): Promise<{ bars: number; from: string; to: string }> {
    const rows = await this.getHistorical(asset, { ...params, symbol, interval }, fetcher)
    return {
      bars: rows.length,
      from: String(rows[0]?.date ?? ''),
      to: String(rows.at(-1)?.date ?? ''),
    }
  }
}

export function createCachedEquityClient(client: EquityClientLike, service: OhlcvCacheService): EquityClientLike {
  return proxyClient(client, {
    getHistorical: (params: Record<string, unknown>) => service.getHistorical('equity', params, (p) => client.getHistorical(p) as Promise<Record<string, unknown>[]>),
  })
}

export function createCachedCryptoClient(client: CryptoClientLike, service: OhlcvCacheService): CryptoClientLike {
  return proxyClient(client, {
    getHistorical: (params: Record<string, unknown>) => service.getHistorical('crypto', params, (p) => client.getHistorical(p) as Promise<Record<string, unknown>[]>),
  })
}

export function createCachedCurrencyClient(client: CurrencyClientLike, service: OhlcvCacheService): CurrencyClientLike {
  return proxyClient(client, {
    getHistorical: (params: Record<string, unknown>) => service.getHistorical('currency', params, (p) => client.getHistorical(p) as Promise<Record<string, unknown>[]>),
  })
}

export function createCachedCommodityClient(client: CommodityClientLike, service: OhlcvCacheService): CommodityClientLike {
  return proxyClient(client, {
    getSpotPrices: (params: Record<string, unknown>) => service.getHistorical('commodity', { interval: '1d', ...params }, (p) => client.getSpotPrices(p) as Promise<Record<string, unknown>[]>),
  })
}

function proxyClient<T extends object>(client: T, overrides: Record<string, unknown>): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop]
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function rangeFromParams(params: Record<string, unknown>): OhlcvRange {
  return {
    startDate: typeof params.start_date === 'string' ? params.start_date : null,
    endDate: typeof params.end_date === 'string' ? params.end_date : null,
  }
}

export function rangeSatisfied(rows: OhlcvBar[], range: OhlcvRange, interval = '1d', now = new Date()): boolean {
  if (rows.length === 0) return false
  const visible = filterRange(rows, range)
  if (visible.length === 0) return false
  const first = visible[0].date
  const last = visible.at(-1)!.date
  const effectiveEnd = range.endDate ?? latestClosedPoint(interval, now)
  return (!range.startDate || startsOnOrBefore(first, range.startDate)) && last >= effectiveEnd
}

export function filterClosedBars(rows: Record<string, unknown>[], interval: string, now: Date): OhlcvBar[] {
  const normalized = normalizeFetched(rows)
  const cutoff = closedCutoff(interval, now)
  return normalized.filter((bar) => bar.date < cutoff)
}

function normalizeFetched(rows: Record<string, unknown>[]): OhlcvBar[] {
  return rows
    .filter((row) => row.date != null && row.open != null && row.high != null && row.low != null && row.close != null)
    .map((row) => ({
      ...row,
      date: String(row.date),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume == null ? null : Number(row.volume),
      vwap: row.vwap == null ? null : Number(row.vwap),
    }))
    .filter((bar) => Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function buildGapRequests(
  params: Record<string, unknown>,
  cached: OhlcvBar[],
  range: OhlcvRange,
  interval: string,
  now: Date,
  maxGapRequests: number,
): Record<string, unknown>[] {
  if (cached.length === 0) return [params]

  const requests: Record<string, unknown>[] = []
  const first = cached[0].date
  const last = cached.at(-1)!.date
  const end = range.endDate ?? latestClosedPoint(interval, now)

  if (range.startDate && first > range.startDate) {
    requests.push({
      ...params,
      start_date: range.startDate,
      end_date: previousPoint(first, interval) ?? first,
    })
  }

  if (last < end) {
    requests.push({
      ...params,
      start_date: nextPoint(last, interval) ?? last,
      ...(range.endDate ? { end_date: range.endDate } : {}),
    })
  }

  return requests.slice(0, Math.max(1, maxGapRequests))
}

function closedCutoff(interval: string, now: Date): string {
  if (/^\d+[mhd]$/.test(interval)) {
    const ms = intervalToMs(interval) ?? 0
    const currentPeriodStart = new Date(Math.floor(now.getTime() / ms) * ms)
    if (/^\d+d$/.test(interval)) return currentPeriodStart.toISOString().slice(0, 10)
    return currentPeriodStart.toISOString().replace('T', ' ').slice(0, 19)
  }
  if (interval === '1W' || interval.endsWith('w')) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    d.setUTCDate(d.getUTCDate() - d.getUTCDay())
    return d.toISOString().slice(0, 10)
  }
  if (interval === '1M') {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  }
  return now.toISOString().slice(0, 10)
}

function latestClosedPoint(interval: string, now: Date): string {
  const ms = intervalToMs(interval)
  if (ms) {
    const closedStartMs = Math.floor(now.getTime() / ms) * ms - ms
    const date = new Date(closedStartMs)
    if (/^\d+d$/.test(interval)) return date.toISOString().slice(0, 10)
    return date.toISOString().replace('T', ' ').slice(0, 19)
  }
  if (interval === '1W' || interval.endsWith('w')) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    d.setUTCDate(d.getUTCDate() - d.getUTCDay() - 7)
    return d.toISOString().slice(0, 10)
  }
  if (interval === '1M') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    d.setUTCMonth(d.getUTCMonth() - 1)
    return d.toISOString().slice(0, 10)
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function intervalToMs(interval: string): number | null {
  const match = interval.match(/^(\d+)([mhd])$/)
  if (!match) return null
  const n = Number(match[1])
  const unit = match[2]
  if (unit === 'm') return n * 60_000
  if (unit === 'h') return n * 3_600_000
  if (unit === 'd') return n * 86_400_000
  return null
}

function previousPoint(date: string, interval: string): string | null {
  return shiftPoint(date, interval, -1)
}

function nextPoint(date: string, interval: string): string | null {
  return shiftPoint(date, interval, 1)
}

function shiftPoint(date: string, interval: string, direction: 1 | -1): string | null {
  const ms = intervalToMs(interval)
  if (!ms) return null
  const parsed = parseOhlcvTime(date)
  if (!Number.isFinite(parsed)) return null
  const shifted = new Date(parsed + direction * ms)
  if (/^\d+d$/.test(interval) || date.length <= 10) return shifted.toISOString().slice(0, 10)
  return shifted.toISOString().replace('T', ' ').slice(0, 19)
}

function startsOnOrBefore(first: string, start: string): boolean {
  return first <= start || (start.length <= 10 && first.slice(0, 10) <= start)
}

function parseOhlcvTime(date: string): number {
  const iso = date.replace(' ', 'T')
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)
  return Date.parse(hasTimezone ? iso : `${iso}Z`)
}
