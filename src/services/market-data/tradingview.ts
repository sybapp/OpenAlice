import { tradingview } from '@traderalice/opentypebb'
import type {
  MarketDataCatalogEndpoint,
  MarketDataScanInput,
  MarketDataScanPreset,
  MarketDataTradingViewStudyInput,
} from './types.js'
import { MARKET_DATA_MAX_LIMIT } from './types.js'

type TradingViewQuery = InstanceType<typeof tradingview.Query>

export const DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS = 10000

export const TRADINGVIEW_GENERIC_ENDPOINTS = [
  {
    endpoint: '/tradingview/scan',
    model: 'TradingViewScan',
    description: 'Run a TradingView market scanner preset or custom scanner query.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/symbol-search',
    model: 'TradingViewSymbolSearch',
    description: 'Search TradingView symbols and return TradingView-qualified symbol ids.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/technical-analysis',
    model: 'TradingViewTechnicalAnalysis',
    description: 'Fetch TradingView technical-analysis recommendation values by symbol and period.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/candles',
    model: 'TradingViewCandles',
    description: 'Get a one-shot TradingView realtime chart candle snapshot.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/quote',
    model: 'TradingViewQuote',
    description: 'Get a one-row latest-price snapshot for a TradingView symbol.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/indicator-search',
    model: 'TradingViewIndicatorSearch',
    description: 'Search public and built-in TradingView Pine indicators.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/indicator',
    model: 'TradingViewIndicator',
    description: 'Get TradingView Pine indicator metadata and script payload by id.',
    providers: ['tradingview'],
  },
  {
    endpoint: '/tradingview/study',
    model: 'TradingViewStudy',
    description: 'Run a TradingView chart study once and return parsed indicator values.',
    providers: ['tradingview'],
  },
] satisfies MarketDataCatalogEndpoint[]

const TRADINGVIEW_SCAN_COMPACT_COLUMNS = [
  'name',
  'close',
  'change',
  'volume',
  'market_cap_basic',
  'currency',
  'type',
  'sector',
  'AnalystRating',
]

const SCAN_PRESETS: Record<MarketDataScanPreset, (market?: string) => TradingViewQuery> = {
  stocks: tradingview.stocks,
  coin: tradingview.coin,
  crypto: tradingview.crypto,
  cryptoDex: tradingview.cryptoDex,
  crypto_dex: tradingview.crypto_dex,
  forex: tradingview.forex,
  futures: tradingview.futures,
  bond: tradingview.bond,
  cfd: tradingview.cfd,
  options: (underlying) => tradingview.options(underlying ?? 'NASDAQ:AAPL'),
}

export function createTimeoutError(message: string, timeoutMs: number): Error {
  return new Error(`${message} within ${timeoutMs}ms.`)
}

export function applyTradingViewStudyInputs(
  indicator: tradingview.TradingViewPineIndicator | tradingview.TradingViewBuiltInIndicator,
  inputs: Record<string, string | number | boolean> | undefined,
): void {
  if (!inputs) return
  for (const [key, value] of Object.entries(inputs)) {
    if (indicator instanceof tradingview.TradingViewBuiltInIndicator) {
      indicator.setOption(key, value, true)
      continue
    }
    indicator.setOption(key, value)
  }
}

export function isBuiltInTradingViewIndicator(id: string): boolean {
  return id.includes('@tv-')
}

export function tradingViewStudyIndicatorId(input: MarketDataTradingViewStudyInput): string {
  return input.builtInType ?? input.indicatorId ?? input.indicator?.id ?? ''
}

export function tradingViewStudyIndicatorVersion(input: MarketDataTradingViewStudyInput): string {
  return input.indicatorVersion ?? input.indicator?.version ?? 'last'
}

function tradingViewTimestampToIso(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined
  }
  return new Date(timestamp * 1000).toISOString()
}

export function tradingViewCandleRow(
  symbol: string,
  candle: tradingview.TradingViewCandle,
  options: { marketInfo?: unknown; includeMarketInfo?: boolean } = {},
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    symbol,
    ...candle,
    timeISO: tradingViewTimestampToIso(candle.time),
  }
  if (options.includeMarketInfo) {
    row.marketInfo = options.marketInfo ?? null
  }
  return row
}

export function tradingViewStudyPointRow(point: tradingview.TradingViewStudyPlotPoint): tradingview.TradingViewStudyPlotPoint {
  return {
    ...point,
    $timeISO: tradingViewTimestampToIso(point.$time),
  }
}

export function tradingViewStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`params.${key} must be a string.`)
  }
  return value
}

export function tradingViewRequiredStringParam(params: Record<string, unknown>, key: string, endpoint: string): string {
  const value = tradingViewStringParam(params, key)
  if (!value) {
    throw new Error(`${endpoint} requires params.${key}.`)
  }
  return value
}

export function tradingViewNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  throw new Error(`params.${key} must be a finite number.`)
}

export function tradingViewBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  throw new Error(`params.${key} must be a boolean.`)
}

export function tradingViewRecordParam(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`params.${key} must be an object.`)
}

export function tradingViewPrimitiveRecordParam(params: Record<string, unknown>, key: string): Record<string, string | number | boolean> | undefined {
  const value = tradingViewRecordParam(params, key)
  if (!value) {
    return undefined
  }
  const result: Record<string, string | number | boolean> = {}
  for (const [itemKey, itemValue] of Object.entries(value)) {
    if (typeof itemValue !== 'string' && typeof itemValue !== 'number' && typeof itemValue !== 'boolean') {
      throw new Error(`params.${key}.${itemKey} must be a string, number, or boolean.`)
    }
    result[itemKey] = itemValue
  }
  return result
}

export function tradingViewStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) {
      throw new Error(`params.${key} must contain only strings.`)
    }
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
  }
  throw new Error(`params.${key} must be a string array or comma-separated string.`)
}

export function tradingViewTimeframeFromInterval(interval: unknown): tradingview.TradingViewTimeframe {
  switch (interval) {
    case '1m':
    case '1':
      return '1'
    case '5m':
    case '5':
      return '5'
    case '1h':
    case '60':
      return '60'
    case '1d':
    case '1D':
    default:
      return '1D'
  }
}

export function tradingViewRangeFromParams(params: Record<string, unknown>, fallback = 365): number {
  const explicitRange = tradingViewNumberParam(params, 'range')
  if (explicitRange !== undefined) {
    return explicitRange
  }
  const start = tradingViewStringParam(params, 'start_date')
  if (!start) {
    const limit = tradingViewNumberParam(params, 'limit')
    if (limit !== undefined) {
      return limit
    }
    return fallback
  }
  const startTime = new Date(`${start}T00:00:00Z`).getTime()
  if (!Number.isFinite(startTime)) {
    return fallback
  }
  const days = Math.ceil((Date.now() - startTime) / 86_400_000)
  return Math.max(1, Math.min(MARKET_DATA_MAX_LIMIT, days))
}

export function tradingViewHistoricalRow(row: Record<string, unknown>): Record<string, unknown> {
  const timeISO = typeof row.timeISO === 'string' ? row.timeISO : undefined
  return {
    date: timeISO?.slice(0, 10) ?? row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    symbol: row.symbol,
    time: row.time,
    timeISO,
  }
}

export function isTradingViewAssetEndpoint(endpoint: string): boolean {
  return [
    '/equity/search',
    '/crypto/search',
    '/currency/search',
    '/equity/price/quote',
    '/equity/price/historical',
    '/crypto/price/historical',
    '/currency/price/historical',
    '/commodity/price/spot',
    '/etf/historical',
    '/index/price/historical',
  ].includes(endpoint)
}

export function buildTradingViewQuery(input: MarketDataScanInput, limit: number): TradingViewQuery {
  if (input.mode === 'raw' || input.mode === 'query') {
    if (!input.query) {
      throw new Error(`TradingView ${input.mode} scan requires a query payload.`)
    }
    const query = new tradingview.Query(input.market)
    query.query = structuredClone(input.query) as typeof query.query
    if (input.columns?.length) {
      query.select(...input.columns)
    }
    query.limit(limit)
    return query
  }

  const preset = input.preset ?? 'stocks'
  const factory = SCAN_PRESETS[preset]
  if (!factory) {
    throw new Error(`Unknown TradingView scan preset '${preset}'.`)
  }

  const query = factory(input.market)
  if (input.columns?.length) {
    query.select(...input.columns)
  } else if (input.compact !== false) {
    query.select(...TRADINGVIEW_SCAN_COMPACT_COLUMNS)
  }
  query.limit(limit)
  return query
}
