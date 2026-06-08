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
} from '@traderalice/opentypebb'

export const MARKET_DATA_DEFAULT_LIMIT = 500
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
  limit?: number
  credentials?: { tradingview_sessionid?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
  rawResponse?: boolean
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

export interface MarketDataTechnicalAnalysisInput {
  provider?: 'tradingview' | string
  symbol: string
  periods?: string[]
  credentials?: { tradingview_sessionid?: string } | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MarketDataQuoteSubscription {
  provider: string
  close: () => void
}

export interface MarketDataCandleSubscription {
  provider: string
  getCandles: () => TradingViewCandle[]
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
