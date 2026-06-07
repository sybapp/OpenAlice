import { fetchJson } from './client'

export type AssetClass = 'equity' | 'crypto' | 'currency' | 'commodity'

export interface SearchResult {
  /** Equity / crypto / currency have `symbol`. Commodity uses `id` (canonical). */
  symbol?: string
  id?: string
  name?: string | null
  assetClass: AssetClass
  // upstream fields pass through (cik, source, currency, exchange, exchange_name, category, …)
  [key: string]: unknown
}

export interface SearchResponse {
  results: SearchResult[]
  count: number
}

export interface HistoricalBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface HistoricalResponse {
  results: HistoricalBar[] | null
  provider: string
  error?: string
}

export interface MarketDataEnvelope {
  provider: string
  endpoint: string
  totalCount: number
  fields: string[]
  rows: Array<Record<string, unknown>>
  warnings: string[]
  error?: string
}

/**
 * Raw OBBject envelope for single-record endpoints (profile, quote, …).
 * The provider schemas are rich and not worth mirroring here — panels pick the
 * fields they display. Keep results loose so we don't drift on every provider
 * schema nudge upstream.
 */
export interface OBBjectResponse<T = Record<string, unknown>> {
  results: T[] | null
  provider: string
  error?: string
}

export type EquityProfile = Record<string, unknown>
export type EquityQuote = Record<string, unknown>
export type FinancialRatios = Record<string, unknown>
export type KeyMetrics = Record<string, unknown>
export type FinancialStatementRow = Record<string, unknown>

function equityEndpoint<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<OBBjectResponse<T>> {
  return queryMarketData<T>(`/equity/${path}`, params)
}

async function queryMarketData<T>(
  endpoint: string,
  params: Record<string, string | number> = {},
): Promise<OBBjectResponse<T>> {
  const qs = new URLSearchParams({ endpoint })
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const envelope = await fetchJson<MarketDataEnvelope>(`/api/market-data/query?${qs}`)
  return {
    results: envelope.rows as T[],
    provider: envelope.provider,
    error: envelope.error,
  }
}

export const marketApi = {
  /** Alice's aggregated heuristic search across all asset classes. */
  async search(query: string, limit = 20): Promise<SearchResponse> {
    const qs = new URLSearchParams({ query, limit: String(limit) })
    return fetchJson(`/api/market/search?${qs}`)
  },

  /**
   * Historical OHLCV candles. Provider comes from the server-side default
   * (config.marketData.providers[assetClass]) — UI doesn't pick provider.
   * `assetClass` only decides the URL prefix; `interval` defaults to `1d`.
   */
  async historical(
    assetClass: AssetClass,
    symbol: string,
    opts: { interval?: string; startDate?: string; endDate?: string } = {},
  ): Promise<HistoricalResponse> {
    if (assetClass === 'commodity') {
      throw new Error('commodity historical not supported yet')
    }
    const qs = new URLSearchParams({ symbol })
    qs.set('interval', opts.interval ?? '1d')
    if (opts.startDate) qs.set('start_date', opts.startDate)
    if (opts.endDate) qs.set('end_date', opts.endDate)
    qs.set('endpoint', `/${assetClass}/price/historical`)
    const envelope = await fetchJson<MarketDataEnvelope>(`/api/market-data/query?${qs}`)
    return {
      results: envelope.rows as unknown as HistoricalBar[],
      provider: envelope.provider,
      error: envelope.error,
    }
  },

  /** Equity-specific endpoints — Alice infers provider from config, no ?provider=. */
  equity: {
    profile: (symbol: string) => equityEndpoint<EquityProfile>('profile', { symbol }),
    quote: (symbol: string) => equityEndpoint<EquityQuote>('price/quote', { symbol }),
    metrics: (symbol: string) => equityEndpoint<KeyMetrics>('fundamental/metrics', { symbol }),
    ratios: (symbol: string) => equityEndpoint<FinancialRatios>('fundamental/ratios', { symbol }),
    balance: (symbol: string) => equityEndpoint<FinancialStatementRow>('fundamental/balance', { symbol }),
    income: (symbol: string) => equityEndpoint<FinancialStatementRow>('fundamental/income', { symbol }),
    cashflow: (symbol: string) => equityEndpoint<FinancialStatementRow>('fundamental/cash', { symbol }),
  },
}
