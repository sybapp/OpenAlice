import { Column } from './column.js'
import type {
  Expression,
  FilterOperation,
  Operation,
  OperationComparison,
  SortBy,
  TradingViewCredentials,
  TradingViewQueryPayload,
  TradingViewRawResponse,
  TradingViewRequestOptions,
  TradingViewRow,
  TradingViewScanRawResponse,
  TradingViewScannerData,
  TradingViewSymbolSearchOptions,
  TradingViewSymbolSearchResult,
  TradingViewTechnicalAnalysis,
  TradingViewTechnicalAnalysisInput,
  TradingViewTechnicalSignal,
} from './types.js'

export const DEFAULT_RANGE: [number, number] = [0, 50]
export const SCAN_URL = 'https://scanner.tradingview.com/{market}/scan'
export const GLOBAL_SCAN_URL = 'https://scanner.tradingview.com/global/scan'
export const OPTIONS_SCAN2_URL =
  'https://scanner.tradingview.com/options/scan2?label-product=options-builder'
export const SYMBOL_SEARCH_URL = 'https://symbol-search.tradingview.com/symbol_search/v3'

export const DEFAULT_HEADERS: Record<string, string> = {
  authority: 'scanner.tradingview.com',
  'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="98", "Google Chrome";v="98"',
  accept: 'text/plain, */*; q=0.01',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'sec-ch-ua-mobile': '?0',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)' +
    'Chrome/98.0.4758.102 Safari/537.36',
  'sec-ch-ua-platform': '"Windows"',
  origin: 'https://www.tradingview.com',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  referer: 'https://www.tradingview.com/',
  'accept-language': 'en-US,en;q=0.9,it;q=0.8',
}

export const STOCKS_QUERY: TradingViewQueryPayload = {
  markets: [],
  symbols: {},
  options: { lang: 'en' },
  columns: [
    'name',
    'close',
    'type',
    'typespecs',
    'pricescale',
    'minmov',
    'fractional',
    'minmove2',
    'currency',
    'change',
    'volume',
    'relative_volume_10d_calc',
    'market_cap_basic',
    'fundamental_currency_code',
    'price_earnings_ttm',
    'earnings_per_share_diluted_ttm',
    'earnings_per_share_diluted_yoy_growth_ttm',
    'dividends_yield_current',
    'sector.tr',
    'market',
    'sector',
    'AnalystRating',
    'AnalystRating.tr',
  ],
  filter: [{ left: 'is_primary', operation: 'equal', right: true }],
  filter2: {
    operator: 'and',
    operands: [
      {
        operation: {
          operator: 'or',
          operands: [
            {
              operation: {
                operator: 'and',
                operands: [
                  { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                  { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
                ],
              },
            },
            {
              operation: {
                operator: 'and',
                operands: [
                  { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                  { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } },
                ],
              },
            },
            {
              operation: {
                operator: 'and',
                operands: [
                  { expression: { left: 'type', operation: 'equal', right: 'dr' } },
                ],
              },
            },
            {
              operation: {
                operator: 'and',
                operands: [
                  { expression: { left: 'type', operation: 'equal', right: 'fund' } },
                  {
                    expression: {
                      left: 'typespecs',
                      operation: 'has_none_of',
                      right: ['etf', 'mutual', 'closedend'],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } },
    ],
  },
  sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
  range: [...DEFAULT_RANGE],
  ignore_unknown_fields: false,
}

function scannerUrl(market: string): string {
  return SCAN_URL.replace('{market}', market)
}

function deepClone<T>(value: T): T {
  return structuredClone(value)
}

function isFilterOperation(value: FilterOperation | Operation): value is FilterOperation {
  return 'left' in value
}

function chain(expressions: Array<FilterOperation | Operation>, operator: 'and' | 'or'): Operation {
  const operands: Array<Expression | Operation> = expressions.map((expr) =>
    isFilterOperation(expr) ? { expression: expr } : expr,
  )
  return { operation: { operator, operands } }
}

export function And(...expressions: Array<FilterOperation | Operation>): Operation {
  return chain(expressions, 'and')
}

export function Or(...expressions: Array<FilterOperation | Operation>): Operation {
  return chain(expressions, 'or')
}

function selectedName(column: Column | string): string {
  return column instanceof Column ? column.name : new Column(column).name
}

function ensureRange(payload: TradingViewQueryPayload): [number, number] {
  if (!payload.range) {
    payload.range = [...DEFAULT_RANGE]
  }
  return payload.range
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {}
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...headers }
}

function applySessionCookie(
  headers: Record<string, string>,
  credentials: TradingViewCredentials | null | undefined,
): Record<string, string> {
  const sessionId = credentials?.tradingview_sessionid
  if (!sessionId) {
    return headers
  }

  const cookieKey = Object.keys(headers).find((key) => key.toLowerCase() === 'cookie')
  if (cookieKey) {
    headers[cookieKey] = `${headers[cookieKey]}; sessionid=${sessionId}`
  } else {
    headers.cookie = `sessionid=${sessionId}`
  }
  return headers
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: TradingViewRequestOptions,
  errorPrefix: string,
): Promise<T> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (!fetchImpl) {
    throw new Error(`No fetch implementation available for ${errorPrefix}`)
  }

  const controller = options.signal ? null : new AbortController()
  const timeoutMs = options.timeoutMs ?? 20_000
  const timeout =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: options.signal ?? controller?.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`${errorPrefix} failed: ${response.status} ${response.statusText}\n Body: ${body}\n`)
    }

    return await response.json() as T
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function normalizeScanResponse(
  payload: TradingViewQueryPayload,
  raw: TradingViewRawResponse,
  isScan2: boolean,
): TradingViewScannerData {
  if (isScan2) {
    const fields = 'fields' in raw ? raw.fields : []
    const symbols = 'symbols' in raw ? raw.symbols ?? [] : []
    return {
      totalCount: raw.totalCount,
      fields,
      rows: symbols.map((row) => {
        const normalized: TradingViewRow = { ticker: row.s }
        for (const [index, field] of fields.entries()) {
          normalized[field] = row.f[index]
        }
        return normalized
      }),
    }
  }

  const fields = payload.columns ?? []
  const data = 'data' in raw ? raw.data : []
  return {
    totalCount: raw.totalCount,
    fields,
    rows: data.map((row) => {
      const normalized: TradingViewRow = { ticker: row.s }
      for (const [index, field] of fields.entries()) {
        normalized[field] = row.d[index]
      }
      return normalized
    }),
  }
}

export class Query {
  query: TradingViewQueryPayload
  url: string

  constructor(market = 'america') {
    this.query = deepClone(STOCKS_QUERY)
    this.query.markets = [market]
    this.url = scannerUrl(market)
  }

  select(...columns: Array<Column | string>): this {
    this.query.columns = columns.map(selectedName)
    return this
  }

  where(...expressions: FilterOperation[]): this {
    this.query.filter = [...expressions]
    return this
  }

  where2(operation: Operation): this {
    this.query.filter2 = operation.operation
    return this
  }

  orderBy(column: Column | string, ascending = true, nullsFirst = false): this {
    const sort: SortBy = {
      sortBy: column instanceof Column ? column.name : column,
      sortOrder: ascending ? 'asc' : 'desc',
      nullsFirst,
    }
    this.query.sort = sort
    return this
  }

  limit(limit: number): this {
    ensureRange(this.query)[1] = limit
    return this
  }

  offset(offset: number): this {
    ensureRange(this.query)[0] = offset
    return this
  }

  setMarkets(...markets: string[]): this {
    if (markets.length === 1) {
      const [market] = markets
      this.url = scannerUrl(market)
      this.query.markets = [market]
    } else {
      this.url = scannerUrl('global')
      this.query.markets = [...markets]
    }
    return this
  }

  setTickers(...tickers: string[]): this {
    this.query.symbols ??= {}
    this.query.symbols.tickers = [...tickers]
    return this.setMarkets()
  }

  setIndex(...indexes: string[]): this {
    this.query.preset ??= 'index_components_market_pages'
    this.query.symbols ??= {}
    this.query.symbols.symbolset = [...indexes]
    return this.setMarkets()
  }

  setProperty(key: string, value: unknown): this {
    this.query[key] = value
    return this
  }

  async getScannerDataRaw(options: TradingViewRequestOptions = {}): Promise<TradingViewRawResponse> {
    ensureRange(this.query)

    const headers = applySessionCookie(
      { ...DEFAULT_HEADERS, ...headersToRecord(options.headers) },
      options.credentials,
    )

    return await requestJson<TradingViewRawResponse>(
      this.url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(this.query),
      },
      options,
      'TradingView scanner request',
    )
  }

  async getScannerData(options: TradingViewRequestOptions = {}): Promise<TradingViewScannerData> {
    const raw = await this.getScannerDataRaw(options)
    return normalizeScanResponse(this.query, raw, this.url.includes('/scan2'))
  }

  copy(): Query {
    const next = new Query()
    next.query = deepClone(this.query)
    next.url = this.url
    return next
  }

  order_by(column: Column | string, ascending = true, nulls_first = false): this {
    return this.orderBy(column, ascending, nulls_first)
  }

  set_markets(...markets: string[]): this {
    return this.setMarkets(...markets)
  }

  set_tickers(...tickers: string[]): this {
    return this.setTickers(...tickers)
  }

  set_index(...indexes: string[]): this {
    return this.setIndex(...indexes)
  }

  set_property(key: string, value: unknown): this {
    return this.setProperty(key, value)
  }

  get_scanner_data_raw(options: TradingViewRequestOptions = {}): Promise<TradingViewRawResponse> {
    return this.getScannerDataRaw(options)
  }

  get_scanner_data(options: TradingViewRequestOptions = {}): Promise<TradingViewScannerData> {
    return this.getScannerData(options)
  }
}

type SymbolSearchRaw = {
  symbols?: Array<{
    prefix?: string
    exchange?: string
    symbol?: string
    description?: string
    type?: string
  }>
}

export async function searchSymbols(
  search: string,
  options: TradingViewSymbolSearchOptions = {},
): Promise<TradingViewSymbolSearchResult[]> {
  const [maybeExchange, ...rest] = search.toUpperCase().trim().replace(/ /g, '+').split(':')
  const hasExchange = rest.length > 0
  const text = hasExchange ? rest.join(':') : maybeExchange
  const params = new URLSearchParams({
    text,
    start: String(options.offset ?? 0),
  })
  if (hasExchange) {
    params.set('exchange', maybeExchange)
  }
  if (options.type) {
    params.set('search_type', options.type)
  }

  const headers = applySessionCookie(
    { origin: 'https://www.tradingview.com', ...headersToRecord(options.headers) },
    options.credentials,
  )
  const raw = await requestJson<SymbolSearchRaw>(
    `${SYMBOL_SEARCH_URL}?${params.toString()}`,
    { method: 'GET', headers },
    options,
    'TradingView symbol search request',
  )

  return (raw.symbols ?? []).map((symbol) => {
    const exchange = String(symbol.exchange ?? '').split(' ')[0]
    const prefix = symbol.prefix ? String(symbol.prefix) : exchange.toUpperCase()
    const rawSymbol = String(symbol.symbol ?? '')
    return {
      id: prefix ? `${prefix}:${rawSymbol}` : rawSymbol,
      exchange,
      fullExchange: String(symbol.exchange ?? ''),
      symbol: rawSymbol,
      description: String(symbol.description ?? ''),
      type: String(symbol.type ?? ''),
    }
  })
}

const technicalIndicators = ['Recommend.Other', 'Recommend.All', 'Recommend.MA'] as const
const defaultTechnicalPeriods = ['1', '5', '15', '60', '240', '1D', '1W', '1M']

function technicalColumns(periods: string[]): string[] {
  return periods.flatMap((period) =>
    technicalIndicators.map((indicator) => (period === '1D' ? indicator : `${indicator}|${period}`)),
  )
}

export async function getTechnicalAnalysis(
  input: TradingViewTechnicalAnalysisInput,
  options: TradingViewRequestOptions = {},
): Promise<TradingViewTechnicalAnalysis> {
  const periods = input.periods?.length ? input.periods : defaultTechnicalPeriods
  const columns = technicalColumns(periods)
  const headers = applySessionCookie(
    { ...DEFAULT_HEADERS, ...headersToRecord(options.headers) },
    options.credentials,
  )
  const raw = await requestJson<TradingViewScanRawResponse>(
    GLOBAL_SCAN_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        symbols: { tickers: [input.symbol] },
        columns,
      }),
    },
    options,
    'TradingView technical analysis request',
  )

  const values = raw.data[0]?.d ?? []
  const byPeriod: TradingViewTechnicalAnalysis['periods'] = {}
  for (const [index, column] of columns.entries()) {
    const [indicator, period = '1D'] = column.split('|')
    const key = indicator.replace('Recommend.', '') as keyof TradingViewTechnicalSignal
    byPeriod[period] ??= { Other: null, All: null, MA: null }
    const value = values[index]
    byPeriod[period][key] = typeof value === 'number' ? Math.round(value * 1000) / 500 : null
  }

  return {
    symbol: input.symbol,
    periods: byPeriod,
  }
}
