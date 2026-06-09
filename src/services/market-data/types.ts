import type {
  CommandDef,
  QueryExecutor,
  Registry,
  Router,
  TradingViewCandle,
  TradingViewChartMarketOptions,
  TradingViewChartUpdate,
  TradingViewQuoteData,
  TradingViewQuoteField,
  TradingViewQuoteFieldPreset,
  TradingViewRealtimeClient,
  TradingViewRealtimeClientOptions,
  TradingViewRealtimeCredentials,
  TradingViewRealtimeSocketFactory,
  TradingViewStudyUpdate,
  TradingViewTimeframe,
} from '@traderalice/opentypebb'

export const MARKET_DATA_DEFAULT_LIMIT = 50
export const MARKET_DATA_MAX_LIMIT = 500

export type MarketDataAssetClass =
  | 'equity'
  | 'crypto'
  | 'currency'
  | 'commodity'
  | 'etf'
  | 'index'
  | 'derivatives'
  | 'economy'
  | 'news'

export interface MarketDataConfig {
  providers: {
    equity: string
    crypto: string
    currency: string
    commodity: string
    scanner?: string
  }
  providerKeys?: Record<string, string | undefined>
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

export interface MarketDataCatalogProvider {
  name: string
  description: string
  website?: string
  credentials: string[]
  models: string[]
}

export interface MarketDataCatalogEndpoint {
  endpoint: string
  model: string
  description: string
  providers: string[]
}

export interface MarketDataCatalog {
  providers: MarketDataCatalogProvider[]
  endpoints: MarketDataCatalogEndpoint[]
}

export interface MarketDataQueryInput {
  endpoint: string
  params?: Record<string, unknown>
  provider?: string
  limit?: number
  credentials?: Record<string, string>
}

export interface MarketDataEndpointSearchInput {
  query?: string
  assetClass?: MarketDataAssetClass
  provider?: string
  model?: string
  limit?: number
}

export interface MarketDataSearchInput {
  assetClass: Exclude<MarketDataAssetClass, 'derivatives' | 'economy' | 'news'>
  query: string
  provider?: string
  limit?: number
  params?: Record<string, unknown>
  credentials?: Record<string, string>
}

export interface MarketDataHistoricalInput {
  assetClass: Exclude<MarketDataAssetClass, 'economy' | 'news'>
  symbol: string
  provider?: string
  limit?: number
  params?: Record<string, unknown>
  credentials?: Record<string, string>
}

export interface MarketDataIndicatorInput {
  asset: 'equity' | 'crypto' | 'currency' | 'commodity'
  formula: string
  precision?: number
  provider?: string
  credentials?: Record<string, string>
}

export type MarketDataScanPreset =
  | 'stocks'
  | 'coin'
  | 'crypto'
  | 'cryptoDex'
  | 'crypto_dex'
  | 'forex'
  | 'futures'
  | 'bond'
  | 'cfd'
  | 'options'

export interface MarketDataScanInput {
  provider?: 'tradingview' | string
  mode?: 'preset' | 'query' | 'raw'
  preset?: MarketDataScanPreset
  market?: string
  query?: Record<string, unknown>
  columns?: string[]
  compact?: boolean
  limit?: number
  credentials?: { tradingview_sessionid?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
  rawResponse?: boolean
}

export type MarketDataFundamentalStatement =
  | 'income'
  | 'balance'
  | 'cash'
  | 'ratios'
  | 'metrics'
  | 'reported'

export interface MarketDataFundamentalInput {
  symbol: string
  statement: MarketDataFundamentalStatement
  provider?: string
  period?: string
  limit?: number
  params?: Record<string, unknown>
  credentials?: Record<string, string>
}

export interface MarketDataEarningsInput {
  symbol?: string
  provider?: string
  limit?: number
  params?: Record<string, unknown>
  credentials?: Record<string, string>
}

export interface MarketDataFilingsInput {
  symbol: string
  provider?: string
  limit?: number
  params?: Record<string, unknown>
  credentials?: Record<string, string>
}

export interface MarketDataQuoteSubscriptionInput {
  provider?: 'tradingview' | string
  symbol: string
  session?: string
  fields?: TradingViewQuoteFieldPreset
  customFields?: TradingViewQuoteField[]
  credentials?: TradingViewRealtimeCredentials | null
  socketFactory?: TradingViewRealtimeSocketFactory
  onData: (data: TradingViewQuoteData) => void
}

export interface MarketDataCandleSubscriptionInput {
  provider?: 'tradingview' | string
  symbol: string
  options?: TradingViewChartMarketOptions
  credentials?: TradingViewRealtimeCredentials | null
  socketFactory?: TradingViewRealtimeSocketFactory
  onData: (data: TradingViewChartUpdate) => void
}

export interface MarketDataTradingViewSymbolSearchInput {
  provider?: 'tradingview' | string
  query: string
  type?: string
  offset?: number
  limit?: number
  credentials?: { tradingview_sessionid?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MarketDataTradingViewIndicatorSearchInput {
  provider?: 'tradingview' | string
  query?: string
  includeBuiltIn?: boolean
  limit?: number
  credentials?: { tradingview_sessionid?: string; tradingview_sessionid_sign?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MarketDataTradingViewIndicatorInput {
  provider?: 'tradingview' | string
  id: string
  version?: string
  credentials?: { tradingview_sessionid?: string; tradingview_sessionid_sign?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MarketDataTechnicalAnalysisInput {
  provider?: 'tradingview' | string
  symbol: string
  periods?: string[]
  credentials?: { tradingview_sessionid?: string; tradingview_sessionid_sign?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MarketDataTradingViewCandlesInput {
  provider?: 'tradingview' | string
  symbol: string
  options?: TradingViewChartMarketOptions
  includeMarketInfo?: boolean
  credentials?: TradingViewRealtimeCredentials | null
  socketFactory?: TradingViewRealtimeSocketFactory
  timeoutMs?: number
}

export interface MarketDataTradingViewQuoteInput extends MarketDataTradingViewCandlesInput {}

export interface MarketDataTradingViewStudyInput {
  provider?: 'tradingview' | string
  symbol: string
  options?: TradingViewChartMarketOptions
  indicatorId?: string
  indicatorVersion?: string
  indicator?: { id: string; version?: string }
  builtInType?: string
  inputs?: Record<string, string | number | boolean>
  credentials?: TradingViewRealtimeCredentials | null
  socketFactory?: TradingViewRealtimeSocketFactory
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MarketDataTradingViewStudyResult {
  symbol: string
  candles: TradingViewCandle[]
  study: TradingViewStudyUpdate
}

export interface MarketDataQuoteSubscription {
  provider: string
  close: () => void
}

export interface MarketDataCandleSubscription {
  provider: string
  getCandles: () => TradingViewCandle[]
  setMarket: (symbol: string, options?: TradingViewChartMarketOptions) => void
  setSeries: (timeframe: TradingViewTimeframe, range?: number, reference?: number) => void
  fetchMore: (count?: number) => void
  setTimezone: (timezone: string) => void
  replayStep: (count?: number) => Promise<void>
  replayStart: (interval?: number) => Promise<void>
  replayStop: () => Promise<void>
  close: () => void
}

export interface MarketDataServiceDeps {
  executor: QueryExecutor
  registry: Registry
  router: Router
  readConfig: () => Promise<MarketDataConfig> | MarketDataConfig
  credentialsForConfig?: (providerKeys: MarketDataConfig['providerKeys']) => Record<string, string>
  createTradingViewRealtimeClient?: (
    options: TradingViewRealtimeClientOptions,
  ) => TradingViewRealtimeClient
}

export type MarketDataCommandMap = Map<string, CommandDef>
