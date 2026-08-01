import type { AssetClass } from '../../aggregate-search.js'
import type {
  BarSourceCandidate,
  GetBarsOpts,
  OhlcvBar,
  VendorBarRequestContext,
  VendorBarAdapter,
} from '../types.js'
import type {
  TradingViewBar,
  TradingViewBarsRequest,
  TradingViewClient,
  TradingViewSearchHit,
  TradingViewSearchType,
} from './tradingview-client.js'

export const TRADINGVIEW_PROVIDER_ID = 'tradingview'
const TRADINGVIEW_INTERVALS = {
  '1m': { protocol: '1', minutes: 1 },
  '3m': { protocol: '3', minutes: 3 },
  '5m': { protocol: '5', minutes: 5 },
  '15m': { protocol: '15', minutes: 15 },
  '30m': { protocol: '30', minutes: 30 },
  '1h': { protocol: '60', minutes: 60 },
  '4h': { protocol: '240', minutes: 240 },
  '1d': { protocol: 'D', minutes: 1_440 },
  '1w': { protocol: 'W', minutes: 10_080 },
} as const

export const TRADINGVIEW_SUPPORTED_INTERVALS = Object.keys(TRADINGVIEW_INTERVALS)

export const TRADINGVIEW_VENDOR_INFO = {
  id: TRADINGVIEW_PROVIDER_ID,
  name: 'TradingView Free',
  keyless: true,
  coverage: 'Anonymous global OHLCV for equities, crypto, and FX; freshness and volume coverage depend on the exchange.',
  howToUse:
    'Use exchange-qualified symbols such as NASDAQ:AAPL, SZSE:300820, HKEX:0700, BINANCE:BTCUSDT, or FX:EURUSD; ' +
    'bare symbols such as AAPL are resolved through TradingView symbol search. ' +
    'Treat the feed as delayed unless freshness is independently verified. Bare US equities may use partial-market Cboe volume rather than SIP consolidated volume.',
  website: 'https://www.tradingview.com/',
} as const

const SEARCH_TYPE: Partial<Record<AssetClass, TradingViewSearchType>> = {
  equity: 'stock',
  crypto: 'crypto',
  currency: 'forex',
}
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export interface CreateTradingViewBarAdapterOptions {
  client: TradingViewClient
  enabledAssetClasses: () => Promise<AssetClass[]>
}

function validateDate(value: string | undefined, name: 'start' | 'end' | 'asOf'): void {
  if (value === undefined) return
  const date = DATE_ONLY.test(value) ? new Date(`${value}T00:00:00Z`) : null
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid TradingView ${name} date "${value}"; expected YYYY-MM-DD`)
  }
}

function validateWindow(opts: GetBarsOpts): void {
  validateDate(opts.start, 'start')
  validateDate(opts.end, 'end')
  validateDate(opts.asOf, 'asOf')
  const upper = opts.end ?? opts.asOf
  if (opts.start && upper && opts.start > upper) {
    throw new Error('TradingView start date must not be after end date')
  }
}

function rangeFor(opts: GetBarsOpts, intervalMinutes: number): number {
  if (opts.count != null) return Math.max(1, Math.min(opts.count, 10_000))
  if (!opts.start) return opts.interval === '1m' ? 5_000 : 1_000
  const start = new Date(`${opts.start}T00:00:00Z`).getTime()
  const end = opts.end
    ? new Date(`${opts.end}T23:59:59Z`).getTime()
    : Date.now()
  const bars = Math.ceil(Math.max(1, end - start) / 60_000 / intervalMinutes)
  return Math.max(100, Math.min(bars + 50, 10_000))
}

function endTimestamp(opts: GetBarsOpts): number | null {
  const end = opts.end ?? opts.asOf
  return end ? Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1_000) : null
}

function fullSymbol(row: TradingViewSearchHit): string {
  const symbol = row.symbol.toUpperCase()
  const prefix = row.prefix?.toUpperCase() ?? ''
  const exchange = row.exchange?.split(' ')[0].toUpperCase() ?? ''
  const source = prefix || exchange
  return source && symbol ? `${source}:${symbol}` : symbol
}

const AUTO_SEARCH_TYPES: TradingViewSearchType[] = ['stock', 'crypto', 'forex']

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

function searchTypesFor(assetClass: AssetClass | undefined): TradingViewSearchType[] {
  const preferred = assetClass ? SEARCH_TYPE[assetClass] : undefined
  return preferred ? [preferred] : AUTO_SEARCH_TYPES
}

function exactHit(rows: TradingViewSearchHit[], symbol: string): TradingViewSearchHit | undefined {
  const target = normalizedSymbol(symbol)
  return rows.find((row) => normalizedSymbol(row.symbol) === target)
}

function mapCandidate(row: TradingViewSearchHit, assetClass: AssetClass): BarSourceCandidate | null {
  const symbol = fullSymbol(row)
  if (!symbol) return null
  const name = row.description
  const base = name
    ? `${symbol} · ${name} (${TRADINGVIEW_PROVIDER_ID})`
    : `${symbol} (${TRADINGVIEW_PROVIDER_ID})`
  return {
    barId: `${TRADINGVIEW_PROVIDER_ID}|${symbol}`,
    source: 'vendor',
    sourceId: TRADINGVIEW_PROVIDER_ID,
    symbol,
    name,
    assetClass,
    label: `${base} · delayed`,
    barCapability: 'delayed',
    supportedIntervals: [...TRADINGVIEW_SUPPORTED_INTERVALS],
  }
}

function formatBarDate(bar: TradingViewBar, interval: string): string {
  const iso = new Date(bar.time * 1_000).toISOString()
  return interval === '1d' || interval === '1w'
    ? iso.slice(0, 10)
    : iso.slice(0, 19).replace('T', ' ')
}

function insideWindow(date: string, opts: GetBarsOpts): boolean {
  const day = date.slice(0, 10)
  if (opts.start && day < opts.start) return false
  if (opts.end && day > opts.end) return false
  return true
}

export function createTradingViewBarAdapter(
  options: CreateTradingViewBarAdapterOptions,
): VendorBarAdapter {
  const resolvedSymbols = new Map<string, string>()

  async function resolveSymbol(symbol: string, context?: VendorBarRequestContext): Promise<string> {
    const requested = normalizedSymbol(symbol)
    if (requested.includes(':')) return requested

    const key = `${context?.assetClass ?? 'auto'}|${requested}`
    const cached = resolvedSymbols.get(key)
    if (cached) return cached

    let lastError: unknown
    for (const type of searchTypesFor(context?.assetClass)) {
      let rows: TradingViewSearchHit[]
      try {
        // Keep fallback resolution deterministic and bounded: one TradingView
        // search at a time, in the asset-class preference order.
        rows = await options.client.search(requested, type)
      } catch (error) {
        lastError = error
        continue
      }
      const hit = exactHit(rows, requested)
      if (!hit) continue
      const resolved = fullSymbol(hit)
      resolvedSymbols.set(key, resolved)
      return resolved
    }

    if (lastError && searchTypesFor(context?.assetClass).length === 1) throw lastError
    const scope = context?.assetClass ? ` for ${context.assetClass}` : ''
    throw new Error(`TradingView symbol "${symbol}" was not found${scope}`)
  }

  return {
    id: TRADINGVIEW_PROVIDER_ID,
    vendor: TRADINGVIEW_VENDOR_INFO,
    metadata: {
      capability: 'delayed',
      supportedIntervals: TRADINGVIEW_SUPPORTED_INTERVALS,
      supportsCount: true,
    },

    async search(query, { limit }) {
      const enabled = [...new Set(await options.enabledAssetClasses())]
      const requests = enabled.flatMap((assetClass) => {
        const type = SEARCH_TYPE[assetClass]
        return type ? [{ assetClass, promise: options.client.search(query, type) }] : []
      })
      const settled = await Promise.allSettled(requests.map((request) => request.promise))
      const candidates: BarSourceCandidate[] = []
      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index]
        if (result.status !== 'fulfilled') continue
        for (const row of result.value) {
          const candidate = mapCandidate(row, requests[index].assetClass)
          if (candidate) candidates.push(candidate)
          if (candidates.length >= limit) return candidates
        }
      }
      return candidates
    },

    async getBars(symbol, opts, context) {
      const interval = TRADINGVIEW_INTERVALS[opts.interval as keyof typeof TRADINGVIEW_INTERVALS]
      if (!interval) throw new Error(`Unsupported TradingView bar interval "${opts.interval}"`)
      validateWindow(opts)
      const resolvedSymbol = await resolveSymbol(symbol, context)
      const request: TradingViewBarsRequest = {
        symbol: resolvedSymbol,
        interval: interval.protocol,
        range: rangeFor(opts, interval.minutes),
        to: endTimestamp(opts),
      }
      const bars = await options.client.getBars(request)
      return bars
        .map((bar): OhlcvBar => ({
          date: formatBarDate(bar, opts.interval),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        }))
        .filter((bar) => insideWindow(bar.date, opts))
        .sort((a, b) => a.date.localeCompare(b.date))
    },
  }
}
