export type TradingViewFilterOperationName =
  | 'greater'
  | 'egreater'
  | 'less'
  | 'eless'
  | 'equal'
  | 'nequal'
  | 'in_range'
  | 'not_in_range'
  | 'empty'
  | 'nempty'
  | 'crosses'
  | 'crosses_above'
  | 'crosses_below'
  | 'match'
  | 'nmatch'
  | 'smatch'
  | 'has'
  | 'has_none_of'
  | 'above%'
  | 'below%'
  | 'in_range%'
  | 'not_in_range%'
  | 'in_day_range'
  | 'in_week_range'
  | 'in_month_range'

export interface FilterOperation {
  left: string
  operation: TradingViewFilterOperationName
  right: unknown
}

export interface Expression {
  expression: FilterOperation
}

export interface OperationComparison {
  operator: 'and' | 'or'
  operands: Array<Operation | Expression>
}

export interface Operation {
  operation: OperationComparison
}

export interface SortBy {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  nullsFirst?: boolean
}

export interface Symbols {
  query?: { types: string[] }
  tickers?: string[]
  symbolset?: string[]
  watchlist?: { id: number }
  groups?: Array<{ type: string; values: string }>
}

export interface TradingViewQueryPayload {
  markets?: string[]
  symbols?: Symbols
  options?: Record<string, unknown>
  columns?: string[]
  filter?: FilterOperation[]
  filter2?: OperationComparison
  sort?: SortBy
  range?: [number, number]
  ignore_unknown_fields?: boolean
  preset?: string
  price_conversion?:
    | { to_symbol: boolean }
    | { to_currency: string }
  index_filters?: Array<{ name: string; values: string[] }>
  [key: string]: unknown
}

export interface TradingViewScanRow {
  s: string
  d: unknown[]
}

export interface TradingViewScanRawResponse {
  totalCount: number
  data: TradingViewScanRow[]
}

export interface TradingViewScan2Row {
  s: string
  f: unknown[]
}

export interface TradingViewScan2RawResponse {
  totalCount: number
  fields: string[]
  symbols?: TradingViewScan2Row[]
  time?: string
}

export type TradingViewRawResponse =
  | TradingViewScanRawResponse
  | TradingViewScan2RawResponse

export type TradingViewRow = {
  ticker: string
  [field: string]: unknown
}

export interface TradingViewScannerData {
  totalCount: number
  fields: string[]
  rows: TradingViewRow[]
}

export interface TradingViewCredentials {
  tradingview_sessionid?: string
  tradingview_sessionid_sign?: string
}

export interface TradingViewRequestOptions {
  fetch?: typeof fetch
  credentials?: TradingViewCredentials | null
  headers?: HeadersInit
  timeoutMs?: number
  signal?: AbortSignal
}

export type TradingViewSymbolSearchType =
  | 'stock'
  | 'futures'
  | 'forex'
  | 'cfd'
  | 'crypto'
  | 'index'
  | 'economic'
  | string

export interface TradingViewSymbolSearchOptions extends TradingViewRequestOptions {
  type?: TradingViewSymbolSearchType
  offset?: number
}

export interface TradingViewSymbolSearchResult {
  id: string
  exchange: string
  fullExchange: string
  symbol: string
  description: string
  type: string
}

export interface TradingViewTechnicalAnalysisInput {
  symbol: string
  periods?: string[]
}

export type TradingViewTechnicalSignal = {
  Other: number | null
  All: number | null
  MA: number | null
}

export interface TradingViewTechnicalAnalysis {
  symbol: string
  periods: Record<string, TradingViewTechnicalSignal>
}
