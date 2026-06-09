import {
  createExecutor,
  createRegistry,
  loadAllRouters,
  tradingview,
  type CommandDef,
} from '@traderalice/opentypebb'
import { readMarketDataConfig } from '@/core/config.js'
import { buildSDKCredentials } from '@/domain/market-data/credential-map.js'
import type {
  MarketDataAssetClass,
  MarketDataCatalog,
  MarketDataCatalogEndpoint,
  MarketDataCatalogProvider,
  MarketDataCandleSubscription,
  MarketDataCandleSubscriptionInput,
  MarketDataCommandMap,
  MarketDataConfig,
  MarketDataEnvelope,
  MarketDataHistoricalInput,
  MarketDataIndicatorInput,
  MarketDataQueryInput,
  MarketDataQuoteSubscription,
  MarketDataQuoteSubscriptionInput,
  MarketDataScanInput,
  MarketDataScanPreset,
  MarketDataSearchInput,
  MarketDataTechnicalAnalysisInput,
  MarketDataTradingViewCandlesInput,
  MarketDataTradingViewIndicatorInput,
  MarketDataTradingViewIndicatorSearchInput,
  MarketDataTradingViewStudyInput,
  MarketDataTradingViewStudyResult,
  MarketDataTradingViewSymbolSearchInput,
  MarketDataServiceDeps,
} from './types.js'
import { MARKET_DATA_DEFAULT_LIMIT, MARKET_DATA_MAX_LIMIT } from './types.js'
import { calculateIndicatorWithService } from './indicator/index.js'

type TradingViewQuery = InstanceType<typeof tradingview.Query>

const DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS = 10000

type RowSource = {
  rows?: unknown
  results?: unknown
  fields?: unknown
  warnings?: unknown
  totalCount?: unknown
}

const SEARCH_ENDPOINTS: Partial<Record<MarketDataAssetClass, string>> = {
  equity: '/equity/search',
  crypto: '/crypto/search',
  currency: '/currency/search',
  etf: '/etf/search',
  index: '/index/search',
}

const HISTORICAL_ENDPOINTS: Partial<Record<MarketDataAssetClass, string>> = {
  equity: '/equity/price/historical',
  crypto: '/crypto/price/historical',
  currency: '/currency/price/historical',
  commodity: '/commodity/price/spot',
  etf: '/etf/historical',
  index: '/index/price/historical',
  derivatives: '/derivatives/futures/historical',
}

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

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function createTimeoutError(message: string, timeoutMs: number): Error {
  return new Error(`${message} within ${timeoutMs}ms.`)
}

function applyTradingViewStudyInputs(
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

function isBuiltInTradingViewIndicator(id: string): boolean {
  return id.includes('@tv-')
}

function tradingViewStudyIndicatorId(input: MarketDataTradingViewStudyInput): string {
  return input.builtInType ?? input.indicatorId ?? input.indicator?.id ?? ''
}

function tradingViewStudyIndicatorVersion(input: MarketDataTradingViewStudyInput): string {
  return input.indicatorVersion ?? input.indicator?.version ?? 'last'
}

function tradingViewTimestampToIso(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined
  }
  return new Date(timestamp * 1000).toISOString()
}

function tradingViewCandleRow(symbol: string, candle: tradingview.TradingViewCandle, marketInfo?: unknown): Record<string, unknown> {
  return {
    symbol,
    ...candle,
    timeISO: tradingViewTimestampToIso(candle.time),
    marketInfo,
  }
}

function tradingViewStudyPointRow(point: tradingview.TradingViewStudyPlotPoint): tradingview.TradingViewStudyPlotPoint {
  return {
    ...point,
    $timeISO: tradingViewTimestampToIso(point.$time),
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return MARKET_DATA_DEFAULT_LIMIT
  }
  return Math.max(0, Math.min(MARKET_DATA_MAX_LIMIT, Math.floor(limit)))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return { value }
}

function fieldNames(rows: Array<Record<string, unknown>>, explicitFields?: unknown): string[] {
  if (Array.isArray(explicitFields)) {
    return explicitFields.filter((field): field is string => typeof field === 'string')
  }

  const fields = new Set<string>()
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      fields.add(field)
    }
  }
  return [...fields]
}

function warningsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((warning) => {
    if (typeof warning === 'string') {
      return warning
    }
    if (warning && typeof warning === 'object' && 'message' in warning) {
      return String((warning as { message: unknown }).message)
    }
    return String(warning)
  })
}

function normalizeRows(value: unknown, limit: number): {
  rows: Array<Record<string, unknown>>
  fields: string[]
  totalCount: number
  warnings: string[]
} {
  const source = value as RowSource
  const rowValue =
    source && typeof source === 'object' && 'rows' in source
      ? source.rows
      : source && typeof source === 'object' && 'results' in source
        ? source.results
        : value

  const rawRows = Array.isArray(rowValue) ? rowValue : rowValue == null ? [] : [rowValue]
  const rows = rawRows.map(asRecord)
  const totalCount =
    typeof source?.totalCount === 'number'
      ? source.totalCount
      : rows.length

  return {
    rows: rows.slice(0, limit),
    fields: fieldNames(rows.slice(0, limit), source?.fields),
    totalCount,
    warnings: warningsFrom(source?.warnings),
  }
}

function errorEnvelope(provider: string, endpoint: string, error: unknown): MarketDataEnvelope {
  return {
    provider,
    endpoint,
    totalCount: 0,
    fields: [],
    rows: [],
    warnings: [],
    error: error instanceof Error ? error.message : String(error),
  }
}

function assetClassFromEndpoint(endpoint: string): MarketDataAssetClass | undefined {
  const [first] = normalizeEndpoint(endpoint).split('/').filter(Boolean)
  if (!first) {
    return undefined
  }
  return first as MarketDataAssetClass
}

function defaultProviderForAsset(config: MarketDataConfig, assetClass: MarketDataAssetClass | undefined): string {
  switch (assetClass) {
    case 'equity':
      return config.providers.equity
    case 'crypto':
      return config.providers.crypto
    case 'currency':
      return config.providers.currency
    case 'commodity':
      return config.providers.commodity
    case 'etf':
    case 'index':
      return config.providers.equity
    case 'derivatives':
      return config.providers.commodity
    default:
      return ''
  }
}

function providerModels(registry: MarketDataServiceDeps['registry']): Map<string, string[]> {
  const models = new Map<string, string[]>()
  for (const [name, provider] of registry.providers) {
    models.set(name, Object.keys(provider.fetcherDict))
  }
  return models
}

function endpointCatalog(commands: MarketDataCommandMap, modelsByProvider: Map<string, string[]>): MarketDataCatalogEndpoint[] {
  const endpoints: MarketDataCatalogEndpoint[] = []
  for (const [endpoint, command] of commands) {
    const providers = [...modelsByProvider.entries()]
      .filter(([, models]) => models.includes(command.model))
      .map(([provider]) => provider)

    endpoints.push({
      endpoint,
      model: command.model,
      description: command.description,
      providers,
    })
  }
  return endpoints.sort((a, b) => a.endpoint.localeCompare(b.endpoint))
}

function providerCatalog(registry: MarketDataServiceDeps['registry']): MarketDataCatalogProvider[] {
  return [...registry.providers.entries()]
    .map(([name, provider]) => ({
      name,
      description: provider.description,
      website: provider.website,
      credentials: provider.credentials,
      models: Object.keys(provider.fetcherDict).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export class MarketDataService {
  private commandMap: MarketDataCommandMap | null = null

  constructor(private readonly deps: MarketDataServiceDeps) {}

  catalog(): MarketDataCatalog {
    const modelsByProvider = providerModels(this.deps.registry)
    return {
      providers: providerCatalog(this.deps.registry),
      endpoints: endpointCatalog(this.commands(), modelsByProvider),
    }
  }

  async query(input: MarketDataQueryInput): Promise<MarketDataEnvelope> {
    const endpoint = normalizeEndpoint(input.endpoint)
    const command = this.resolveCommand(endpoint)
    const config = await this.deps.readConfig()
    const provider = input.provider ?? defaultProviderForAsset(config, assetClassFromEndpoint(endpoint))
    const limit = clampLimit(input.limit)

    if (!provider) {
      return errorEnvelope(provider, endpoint, `No provider configured for endpoint '${endpoint}'. Pass provider explicitly.`)
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const params = { ...input.params }
      const result = command
        ? await command.handler(this.deps.executor, provider, params, credentials)
        : await this.deps.executor.execute(provider, endpoint.replace(/^\//, ''), params, credentials)
      return this.toEnvelope(provider, endpoint, result, limit)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async search(input: MarketDataSearchInput): Promise<MarketDataEnvelope> {
    const endpoint = SEARCH_ENDPOINTS[input.assetClass]
    if (!endpoint) {
      return errorEnvelope(input.provider ?? '', `/search/${input.assetClass}`, `Search is not supported for asset class '${input.assetClass}'.`)
    }

    return this.query({
      endpoint,
      provider: input.provider,
      limit: input.limit,
      credentials: input.credentials,
      params: {
        query: input.query,
        ...input.params,
      },
    })
  }

  async historical(input: MarketDataHistoricalInput): Promise<MarketDataEnvelope> {
    const endpoint = HISTORICAL_ENDPOINTS[input.assetClass]
    if (!endpoint) {
      return errorEnvelope(input.provider ?? '', `/historical/${input.assetClass}`, `Historical data is not supported for asset class '${input.assetClass}'.`)
    }

    return this.query({
      endpoint,
      provider: input.provider,
      limit: input.limit,
      credentials: input.credentials,
      params: {
        symbol: input.symbol,
        ...input.params,
      },
    })
  }

  async indicator(input: MarketDataIndicatorInput) {
    return await calculateIndicatorWithService(input, this)
  }

  async scan(input: MarketDataScanInput = {}): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/scan'
    const limit = clampLimit(input.limit)

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports generic scan at the service layer.')
    }

    try {
      const query = this.buildTradingViewQuery(input, limit)
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const options = {
        credentials,
        fetch: input.fetch,
        timeoutMs: input.timeoutMs,
      }
      const result = input.rawResponse
        ? await query.getScannerDataRaw(options)
        : await query.getScannerData(options)
      return this.toEnvelope(provider, endpoint, result, limit)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async subscribeQuote(input: MarketDataQuoteSubscriptionInput): Promise<MarketDataQuoteSubscription> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'

    if (provider !== 'tradingview') {
      throw new Error('Only the tradingview provider supports realtime quote subscriptions.')
    }

    const credentials =
      input.credentials ??
      this.deps.credentialsForConfig?.(config.providerKeys) ??
      {}
    const clientFactory =
      this.deps.createTradingViewRealtimeClient ??
      ((options: tradingview.TradingViewRealtimeClientOptions) => new tradingview.TradingViewRealtimeClient(options))
    const client = clientFactory({
      credentials,
      socketFactory: input.socketFactory,
    })
    const session = new tradingview.TradingViewQuoteSession(client, {
      fields: input.fields,
      customFields: input.customFields,
    })
    const subscription = session.subscribe(input.symbol, input.onData, input.session)

    return {
      provider,
      close: () => {
        subscription.close()
        session.close()
        client.close()
      },
    }
  }

  async subscribeCandles(input: MarketDataCandleSubscriptionInput): Promise<MarketDataCandleSubscription> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'

    if (provider !== 'tradingview') {
      throw new Error('Only the tradingview provider supports realtime candle subscriptions.')
    }

    const credentials =
      input.credentials ??
      this.deps.credentialsForConfig?.(config.providerKeys) ??
      {}
    const clientFactory =
      this.deps.createTradingViewRealtimeClient ??
      ((options: tradingview.TradingViewRealtimeClientOptions) => new tradingview.TradingViewRealtimeClient(options))
    const client = clientFactory({
      credentials,
      socketFactory: input.socketFactory,
    })
    const session = new tradingview.TradingViewChartSession(client)
    const subscription = session.subscribe(input.symbol, input.onData, input.options)

    return {
      provider,
      getCandles: () => session.currentCandles,
      setMarket: (symbol, options) => session.setMarket(symbol, options),
      setSeries: (timeframe, range, reference) => session.setSeries(timeframe, range, reference),
      fetchMore: (count) => session.fetchMore(count),
      setTimezone: (timezone) => session.setTimezone(timezone),
      replayStep: (count) => session.replayStep(count),
      replayStart: (interval) => session.replayStart(interval),
      replayStop: () => session.replayStop(),
      close: () => {
        subscription.close()
        session.close()
        client.close()
      },
    }
  }

  async tradingViewCandles(input: MarketDataTradingViewCandlesInput): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/tradingview/candles'

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports TradingView realtime candles at the service layer.')
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const clientFactory =
        this.deps.createTradingViewRealtimeClient ??
        ((options: tradingview.TradingViewRealtimeClientOptions) => new tradingview.TradingViewRealtimeClient(options))
      const client = clientFactory({
        credentials,
        socketFactory: input.socketFactory,
      })
      const session = new tradingview.TradingViewChartSession(client)
      const timeoutMs = input.timeoutMs ?? DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS

      const update = await new Promise<tradingview.TradingViewChartUpdate>((resolve, reject) => {
        let subscription: tradingview.TradingViewChartSubscription | null = null
        const cleanup = () => {
          clearTimeout(timer)
          subscription?.close()
          session.close()
          client.close()
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(createTimeoutError('Timed out waiting for TradingView candle data', timeoutMs))
        }, timeoutMs)
        session.onError((error) => {
          cleanup()
          reject(new Error(error.message))
        })
        subscription = session.subscribe(input.symbol, (data) => {
          cleanup()
          resolve(data)
        }, input.options)
      })

      return this.toEnvelope(provider, endpoint, {
        totalCount: update.candles.length,
        rows: update.candles.map((candle) => tradingViewCandleRow(update.symbol, candle, update.marketInfo)),
        warnings: update.changes.map((change) => `TradingView chart update: ${change}`),
      }, update.candles.length)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async runTradingViewStudy(input: MarketDataTradingViewStudyInput): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/tradingview/study'

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports TradingView study execution at the service layer.')
    }
    const indicatorId = tradingViewStudyIndicatorId(input)
    if (!indicatorId) {
      return errorEnvelope(provider, endpoint, 'TradingView study execution requires indicator, indicatorId, or builtInType.')
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const indicator = input.builtInType || isBuiltInTradingViewIndicator(indicatorId)
        ? new tradingview.TradingViewBuiltInIndicator(indicatorId)
        : await tradingview.getIndicator(indicatorId, tradingViewStudyIndicatorVersion(input), {
          credentials,
          fetch: input.fetch,
          timeoutMs: input.timeoutMs,
        })
      applyTradingViewStudyInputs(indicator, input.inputs)

      const clientFactory =
        this.deps.createTradingViewRealtimeClient ??
        ((options: tradingview.TradingViewRealtimeClientOptions) => new tradingview.TradingViewRealtimeClient(options))
      const client = clientFactory({
        credentials,
        socketFactory: input.socketFactory,
      })
      const chart = new tradingview.TradingViewChartSession(client)
      const timeoutMs = input.timeoutMs ?? DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS

      const result = await new Promise<MarketDataTradingViewStudyResult>((resolve, reject) => {
        let chartSubscription: tradingview.TradingViewChartSubscription | null = null
        let study: tradingview.TradingViewChartStudy | null = null
        let latestCandles: tradingview.TradingViewCandle[] = []
        const cleanup = () => {
          clearTimeout(timer)
          study?.remove()
          chartSubscription?.close()
          chart.close()
          client.close()
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(createTimeoutError('Timed out waiting for TradingView study data', timeoutMs))
        }, timeoutMs)
        chart.onError((error) => {
          cleanup()
          reject(new Error(error.message))
        })
        chartSubscription = chart.subscribe(input.symbol, (data) => {
          latestCandles = data.candles
        }, input.options)
        study = new tradingview.TradingViewChartStudy(chart, indicator)
        study.onError((error) => {
          cleanup()
          reject(new Error(error.message))
        })
        study.onUpdate((update) => {
          cleanup()
          resolve({
            symbol: input.symbol,
            candles: latestCandles,
            study: update,
          })
        })
      })

      return this.toEnvelope(provider, endpoint, {
        totalCount: result.study.points.length,
        rows: [{
          symbol: result.symbol,
          candles: result.candles.map((candle) => tradingViewCandleRow(result.symbol, candle)),
          points: result.study.points.map(tradingViewStudyPointRow),
          graphics: result.study.graphics,
          strategyReport: result.study.strategyReport,
          changes: result.study.changes,
        }],
      }, 1)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async searchTradingViewSymbols(input: MarketDataTradingViewSymbolSearchInput): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/tradingview/symbol-search'
    const limit = clampLimit(input.limit)

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports TradingView symbol search at the service layer.')
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const rows = await tradingview.searchSymbols(input.query, {
        type: input.type,
        offset: input.offset,
        credentials,
        fetch: input.fetch,
        timeoutMs: input.timeoutMs,
      })
      return this.toEnvelope(provider, endpoint, {
        totalCount: rows.length,
        rows,
      }, limit)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async searchTradingViewIndicators(input: MarketDataTradingViewIndicatorSearchInput = {}): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/tradingview/indicator-search'
    const limit = clampLimit(input.limit)

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports TradingView indicator search at the service layer.')
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const rows = await tradingview.searchIndicators(input.query ?? '', {
        includeBuiltIn: input.includeBuiltIn,
        credentials,
        fetch: input.fetch,
        timeoutMs: input.timeoutMs,
      })
      return this.toEnvelope(provider, endpoint, {
        totalCount: rows.length,
        rows,
      }, limit)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async getTradingViewIndicator(input: MarketDataTradingViewIndicatorInput): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/tradingview/indicator'

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports TradingView indicator metadata at the service layer.')
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const indicator = await tradingview.getIndicator(input.id, input.version ?? 'last', {
        credentials,
        fetch: input.fetch,
        timeoutMs: input.timeoutMs,
      })
      return this.toEnvelope(provider, endpoint, {
        totalCount: 1,
        rows: [{
          id: indicator.pineId,
          version: indicator.pineVersion,
          description: indicator.description,
          shortDescription: indicator.shortDescription,
          type: indicator.type,
          inputs: indicator.inputs,
          plots: indicator.plots,
          script: indicator.script,
        }],
      }, 1)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async technicalAnalysis(input: MarketDataTechnicalAnalysisInput): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/technical-analysis'

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports technical analysis at the service layer.')
    }

    try {
      const credentials = input.credentials ?? this.deps.credentialsForConfig?.(config.providerKeys) ?? {}
      const result = await tradingview.getTechnicalAnalysis({
        symbol: input.symbol,
        periods: input.periods,
      }, {
        credentials,
        fetch: input.fetch,
        timeoutMs: input.timeoutMs,
      })
      const rows = Object.entries(result.periods).map(([period, values]) => ({
        symbol: result.symbol,
        period,
        ...values,
      }))
      return this.toEnvelope(provider, endpoint, {
        totalCount: rows.length,
        rows,
      }, MARKET_DATA_MAX_LIMIT)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  private commands(): MarketDataCommandMap {
    if (!this.commandMap) {
      this.commandMap = this.deps.router.getCommandMap()
    }
    return this.commandMap
  }

  private resolveCommand(endpoint: string): CommandDef | undefined {
    return this.commands().get(endpoint)
  }

  private toEnvelope(provider: string, endpoint: string, result: unknown, limit: number): MarketDataEnvelope {
    const normalized = normalizeRows(result, limit)
    return {
      provider,
      endpoint,
      totalCount: normalized.totalCount,
      fields: normalized.fields,
      rows: normalized.rows,
      warnings: normalized.warnings,
    }
  }

  private buildTradingViewQuery(input: MarketDataScanInput, limit: number): TradingViewQuery {
    if (input.mode === 'raw' || input.mode === 'query') {
      if (!input.query) {
        throw new Error(`TradingView ${input.mode} scan requires a query payload.`)
      }
      const query = new tradingview.Query(input.market)
      query.query = structuredClone(input.query) as typeof query.query
      query.limit(limit)
      return query
    }

    const preset = input.preset ?? 'stocks'
    const factory = SCAN_PRESETS[preset]
    if (!factory) {
      throw new Error(`Unknown TradingView scan preset '${preset}'.`)
    }

    const query = factory(input.market)
    query.limit(limit)
    return query
  }
}

export function createMarketDataService(): MarketDataService {
  return new MarketDataService({
    executor: createExecutor(),
    registry: createRegistry(),
    router: loadAllRouters(),
    readConfig: readMarketDataConfig,
    credentialsForConfig: buildSDKCredentials,
  })
}
