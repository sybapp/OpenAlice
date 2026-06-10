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
  MarketDataEndpointSearchInput,
  MarketDataEarningsInput,
  MarketDataEnvelope,
  MarketDataFilingsInput,
  MarketDataFundamentalInput,
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
  MarketDataTradingViewQuoteInput,
  MarketDataTradingViewStudyInput,
  MarketDataTradingViewStudyResult,
  MarketDataTradingViewSymbolSearchInput,
  MarketDataServiceDeps,
} from './types.js'
import { MARKET_DATA_DEFAULT_LIMIT, MARKET_DATA_MAX_LIMIT } from './types.js'
import { calculateIndicatorWithService } from './indicator/index.js'
import {
  DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS,
  TRADINGVIEW_GENERIC_ENDPOINTS,
  applyTradingViewStudyInputs,
  buildTradingViewQuery,
  createTimeoutError,
  isBuiltInTradingViewIndicator,
  isTradingViewAssetEndpoint,
  tradingViewBooleanParam,
  tradingViewCandleRow,
  tradingViewHistoricalRow,
  tradingViewNumberParam,
  tradingViewPrimitiveRecordParam,
  tradingViewRangeFromParams,
  tradingViewRecordParam,
  tradingViewRequiredStringParam,
  tradingViewStringArrayParam,
  tradingViewStringParam,
  tradingViewStudyIndicatorId,
  tradingViewStudyIndicatorVersion,
  tradingViewStudyPointRow,
  tradingViewTimeframeFromInterval,
} from './tradingview.js'

const FUNDAMENTAL_ENDPOINTS = {
  income: '/equity/fundamental/income',
  balance: '/equity/fundamental/balance',
  cash: '/equity/fundamental/cash',
  ratios: '/equity/fundamental/ratios',
  metrics: '/equity/fundamental/metrics',
  reported: '/equity/fundamental/reported_financials',
} satisfies Record<MarketDataFundamentalInput['statement'], string>

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

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
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

function defaultProviderForQuery(config: MarketDataConfig, endpoint: string): string {
  const provider = defaultProviderForAsset(config, assetClassFromEndpoint(endpoint))
  if (provider === 'tradingview' && !isTradingViewAssetEndpoint(endpoint)) {
    return 'yfinance'
  }
  return provider
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
    if (isTradingViewAssetEndpoint(endpoint) && !providers.includes('tradingview')) {
      providers.push('tradingview')
    }

    endpoints.push({
      endpoint,
      model: command.model,
      description: command.description,
      providers,
    })
  }
  endpoints.push(...TRADINGVIEW_GENERIC_ENDPOINTS)
  return endpoints.sort((a, b) => a.endpoint.localeCompare(b.endpoint))
}

function providerCatalog(registry: MarketDataServiceDeps['registry']): MarketDataCatalogProvider[] {
  return [...registry.providers.entries()]
    .map(([name, provider]) => {
      const models = new Set(Object.keys(provider.fetcherDict))
      if (name === 'tradingview') {
        for (const endpoint of TRADINGVIEW_GENERIC_ENDPOINTS) {
          models.add(endpoint.model)
        }
      }
      const credentials = name === 'tradingview'
        ? [...new Set([...provider.credentials, 'tradingview_sessionid', 'tradingview_sessionid_sign'])]
        : provider.credentials
      return {
        name,
        description: provider.description,
        website: provider.website,
        credentials,
        models: [...models].sort(),
      }
    })
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
    const provider = input.provider ?? (this.resolveTradingViewEndpoint(endpoint) ? config.providers.scanner ?? 'tradingview' : defaultProviderForQuery(config, endpoint))
    const limit = clampLimit(input.limit)

    if (!provider) {
      return errorEnvelope(provider, endpoint, `No provider configured for endpoint '${endpoint}'. Pass provider explicitly.`)
    }

    try {
      const tradingViewEndpoint = this.resolveTradingViewEndpoint(endpoint)
      if (tradingViewEndpoint) {
        return await this.queryTradingViewEndpoint(tradingViewEndpoint.endpoint, {
          provider,
          params: input.params ?? {},
          limit,
          credentials: input.credentials,
        })
      }
      if (provider === 'tradingview' && isTradingViewAssetEndpoint(endpoint)) {
        return await this.queryTradingViewAssetEndpoint(endpoint, {
          params: input.params ?? {},
          limit,
          credentials: input.credentials,
        })
      }
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

  async endpointSearch(input: MarketDataEndpointSearchInput = {}): Promise<MarketDataEnvelope> {
    const limit = clampLimit(input.limit)
    const query = input.query?.trim().toLowerCase()
    const model = input.model?.trim().toLowerCase()
    const provider = input.provider?.trim().toLowerCase()
    const assetClass = input.assetClass

    const rows = this.catalog().endpoints.filter((endpoint) => {
      if (assetClass && assetClassFromEndpoint(endpoint.endpoint) !== assetClass) return false
      if (model && !endpoint.model.toLowerCase().includes(model)) return false
      if (provider && !endpoint.providers.some((name) => name.toLowerCase() === provider)) return false
      if (!query) return true
      const haystack = [
        endpoint.endpoint,
        endpoint.model,
        endpoint.description,
        endpoint.providers.join(' '),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })

    return this.toEnvelope('catalog', '/catalog/endpoints', {
      totalCount: rows.length,
      rows,
    }, limit)
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

  async fundamentals(input: MarketDataFundamentalInput): Promise<MarketDataEnvelope> {
    return this.query({
      endpoint: FUNDAMENTAL_ENDPOINTS[input.statement],
      provider: input.provider,
      limit: input.limit,
      credentials: input.credentials,
      params: {
        symbol: input.symbol,
        ...(input.period ? { period: input.period } : {}),
        ...input.params,
      },
    })
  }

  async earnings(input: MarketDataEarningsInput = {}): Promise<MarketDataEnvelope> {
    return this.query({
      endpoint: '/equity/calendar/earnings',
      provider: input.provider,
      limit: input.limit,
      credentials: input.credentials,
      params: {
        ...(input.symbol ? { symbol: input.symbol } : {}),
        ...input.params,
      },
    })
  }

  async filings(input: MarketDataFilingsInput): Promise<MarketDataEnvelope> {
    return this.query({
      endpoint: '/equity/fundamental/filings',
      provider: input.provider,
      limit: input.limit,
      credentials: input.credentials,
      params: {
        symbol: input.symbol,
        ...input.params,
      },
    })
  }

  async scan(input: MarketDataScanInput = {}): Promise<MarketDataEnvelope> {
    const config = await this.deps.readConfig()
    const provider = input.provider ?? config.providers.scanner ?? 'tradingview'
    const endpoint = '/tradingview/scan'
    const limit = clampLimit(input.limit)

    if (provider !== 'tradingview') {
      return errorEnvelope(provider, endpoint, 'Only the tradingview provider supports generic scan at the service layer.')
    }

    try {
      const query = buildTradingViewQuery(input, limit)
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
      server: input.realtimeServer,
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
      server: input.realtimeServer,
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
        server: input.realtimeServer,
        credentials,
        socketFactory: input.socketFactory,
      })
      const session = new tradingview.TradingViewChartSession(client)
      const timeoutMs = input.timeoutMs ?? DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS

      const update = await new Promise<tradingview.TradingViewChartUpdate>((resolve, reject) => {
        let subscription: tradingview.TradingViewChartSubscription | null = null
        let lastUpdate: tradingview.TradingViewChartUpdate | null = null
        let errorReceived: tradingview.TradingViewChartError | null = null

        const cleanup = () => {
          clearTimeout(timer)
          subscription?.close()
          session.close()
          client.close()
        }
        const timer = setTimeout(() => {
          cleanup()
          const diagnostics = [
            `Symbol: ${input.symbol}`,
            `Timeframe: ${input.options?.timeframe ?? '1D'}`,
            `Range: ${input.options?.range ?? 100}`,
            `Last update: ${lastUpdate ? `${lastUpdate.candles.length} candles, changes: ${lastUpdate.changes.join(',')}` : 'none'}`,
            errorReceived ? `Last error: ${errorReceived.kind} - ${errorReceived.message}` : null,
          ].filter(Boolean).join('; ')
          reject(createTimeoutError(
            `Timed out waiting for TradingView candle data. ${diagnostics}`,
            timeoutMs,
          ))
        }, timeoutMs)
        session.onError((error) => {
          errorReceived = error
          cleanup()
          reject(new Error(`TradingView chart error (${error.kind}): ${error.message}. Symbol: ${input.symbol}`))
        })
        subscription = session.subscribe(input.symbol, (data) => {
          lastUpdate = data
          cleanup()
          resolve(data)
        }, input.options)
      })

      return this.toEnvelope(provider, endpoint, {
        totalCount: update.candles.length,
        rows: update.candles.map((candle) => tradingViewCandleRow(update.symbol, candle, {
          includeMarketInfo: input.includeMarketInfo,
          marketInfo: update.marketInfo,
        })),
        warnings: update.changes.map((change) => `TradingView chart update: ${change}`),
      }, update.candles.length)
    } catch (error) {
      return errorEnvelope(provider, endpoint, error)
    }
  }

  async tradingViewQuote(input: MarketDataTradingViewQuoteInput): Promise<MarketDataEnvelope> {
    const candles = await this.tradingViewCandles({
      ...input,
      options: {
        timeframe: '1D',
        range: 2,
        ...input.options,
      },
    })
    const endpoint = '/tradingview/quote'
    if (candles.error) {
      return { ...candles, endpoint }
    }
    const latest = candles.rows.at(-1)
    if (!latest) {
      return errorEnvelope(candles.provider, endpoint, `No TradingView candle data returned for '${input.symbol}'.`)
    }
    return this.toEnvelope(candles.provider, endpoint, {
      totalCount: 1,
      rows: [{
        symbol: latest.symbol ?? input.symbol,
        price: latest.close,
        close: latest.close,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        volume: latest.volume,
        time: latest.time,
        timeISO: latest.timeISO,
        currency: latest.currency,
        source: '/tradingview/candles',
      }],
      warnings: candles.warnings,
    }, 1)
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
        server: input.realtimeServer,
        credentials,
        socketFactory: input.socketFactory,
      })
      const chart = new tradingview.TradingViewChartSession(client)
      const timeoutMs = input.timeoutMs ?? DEFAULT_TRADINGVIEW_REALTIME_TIMEOUT_MS

      const result = await new Promise<MarketDataTradingViewStudyResult>((resolve, reject) => {
        let chartSubscription: tradingview.TradingViewChartSubscription | null = null
        let study: tradingview.TradingViewChartStudy | null = null
        let latestCandles: tradingview.TradingViewCandle[] = []
        let lastStudyUpdate: tradingview.TradingViewStudyUpdate | null = null
        let chartError: tradingview.TradingViewChartError | null = null
        let studyError: tradingview.TradingViewStudyError | null = null

        const cleanup = () => {
          clearTimeout(timer)
          study?.remove()
          chartSubscription?.close()
          chart.close()
          client.close()
        }
        const timer = setTimeout(() => {
          cleanup()
          const diagnostics = [
            `Symbol: ${input.symbol}`,
            `Indicator: ${indicatorId}`,
            `Timeframe: ${input.options?.timeframe ?? '1D'}`,
            `Candles: ${latestCandles.length}`,
            `Last study update: ${lastStudyUpdate ? `${lastStudyUpdate.points.length} points, changes: ${lastStudyUpdate.changes.join(',')}` : 'none'}`,
            chartError ? `Chart error: ${chartError.kind} - ${chartError.message}` : null,
            studyError ? `Study error: ${studyError.message}` : null,
          ].filter(Boolean).join('; ')
          reject(createTimeoutError(
            `Timed out waiting for TradingView study data. ${diagnostics}`,
            timeoutMs,
          ))
        }, timeoutMs)
        chart.onError((error) => {
          chartError = error
          cleanup()
          reject(new Error(`TradingView chart error (${error.kind}): ${error.message}. Symbol: ${input.symbol}, Indicator: ${indicatorId}`))
        })
        chartSubscription = chart.subscribe(input.symbol, (data) => {
          latestCandles = data.candles
        }, input.options)
        study = new tradingview.TradingViewChartStudy(chart, indicator)
        study.onError((error) => {
          studyError = error
          cleanup()
          reject(new Error(`TradingView study error: ${error.message}. Symbol: ${input.symbol}, Indicator: ${indicatorId}`))
        })
        study.onUpdate((update) => {
          lastStudyUpdate = update
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
          graphicTextItems: result.study.graphics.textItems,
          graphicPlainText: result.study.graphics.plainText,
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
    const endpoint = '/tradingview/technical-analysis'

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

  private resolveTradingViewEndpoint(endpoint: string): MarketDataCatalogEndpoint | undefined {
    return TRADINGVIEW_GENERIC_ENDPOINTS.find((entry) => entry.endpoint === endpoint)
  }

  private async queryTradingViewEndpoint(
    endpoint: string,
    input: {
      provider: string
      params: Record<string, unknown>
      limit: number
      credentials?: Record<string, string>
    },
  ): Promise<MarketDataEnvelope> {
    const { provider, params, limit, credentials } = input
    switch (endpoint) {
      case '/tradingview/scan':
        return await this.scan({
          provider,
          mode: tradingViewStringParam(params, 'mode') as MarketDataScanInput['mode'],
          preset: tradingViewStringParam(params, 'preset') as MarketDataScanPreset | undefined,
          market: tradingViewStringParam(params, 'market'),
          query: tradingViewRecordParam(params, 'query'),
          columns: tradingViewStringArrayParam(params, 'columns'),
          compact: tradingViewBooleanParam(params, 'compact'),
          limit,
          credentials,
          rawResponse: tradingViewBooleanParam(params, 'rawResponse'),
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/symbol-search':
        return await this.searchTradingViewSymbols({
          provider,
          query: tradingViewRequiredStringParam(params, 'query', endpoint),
          type: tradingViewStringParam(params, 'type'),
          offset: tradingViewNumberParam(params, 'offset'),
          limit,
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/technical-analysis':
        return await this.technicalAnalysis({
          provider,
          symbol: tradingViewRequiredStringParam(params, 'symbol', endpoint),
          periods: tradingViewStringArrayParam(params, 'periods'),
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/candles':
        return await this.tradingViewCandles({
          provider,
          symbol: tradingViewRequiredStringParam(params, 'symbol', endpoint),
          options: tradingViewRecordParam(params, 'options') as MarketDataTradingViewCandlesInput['options'],
          includeMarketInfo: tradingViewBooleanParam(params, 'includeMarketInfo'),
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/quote':
        return await this.tradingViewQuote({
          provider,
          symbol: tradingViewRequiredStringParam(params, 'symbol', endpoint),
          options: tradingViewRecordParam(params, 'options') as MarketDataTradingViewQuoteInput['options'],
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/indicator-search':
        return await this.searchTradingViewIndicators({
          provider,
          query: tradingViewStringParam(params, 'query'),
          includeBuiltIn: tradingViewBooleanParam(params, 'includeBuiltIn'),
          limit,
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/indicator':
        return await this.getTradingViewIndicator({
          provider,
          id: tradingViewRequiredStringParam(params, 'id', endpoint),
          version: tradingViewStringParam(params, 'version'),
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      case '/tradingview/study':
        return await this.runTradingViewStudy({
          provider,
          symbol: tradingViewRequiredStringParam(params, 'symbol', endpoint),
          options: tradingViewRecordParam(params, 'options') as MarketDataTradingViewStudyInput['options'],
          indicator: tradingViewRecordParam(params, 'indicator') as MarketDataTradingViewStudyInput['indicator'],
          indicatorId: tradingViewStringParam(params, 'indicatorId'),
          indicatorVersion: tradingViewStringParam(params, 'indicatorVersion'),
          builtInType: tradingViewStringParam(params, 'builtInType'),
          inputs: tradingViewPrimitiveRecordParam(params, 'inputs'),
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
      default:
        return errorEnvelope(provider, endpoint, `Unsupported TradingView endpoint '${endpoint}'.`)
    }
  }

  private async queryTradingViewAssetEndpoint(
    endpoint: string,
    input: {
      params: Record<string, unknown>
      limit: number
      credentials?: Record<string, string>
    },
  ): Promise<MarketDataEnvelope> {
    const { params, limit, credentials } = input
    switch (endpoint) {
      case '/equity/search':
      case '/crypto/search':
      case '/currency/search': {
        const type = endpoint === '/equity/search'
          ? 'stock'
          : endpoint === '/crypto/search'
            ? 'crypto'
            : 'forex'
        const result = await this.searchTradingViewSymbols({
          query: tradingViewRequiredStringParam(params, 'query', endpoint),
          type,
          limit,
          credentials,
        })
        return { ...result, endpoint }
      }
      case '/equity/price/quote': {
        const result = await this.tradingViewQuote({
          symbol: tradingViewRequiredStringParam(params, 'symbol', endpoint),
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
        return { ...result, endpoint }
      }
      case '/equity/price/historical':
      case '/crypto/price/historical':
      case '/currency/price/historical':
      case '/commodity/price/spot':
      case '/etf/historical':
      case '/index/price/historical': {
        const candles = await this.tradingViewCandles({
          symbol: tradingViewRequiredStringParam(params, 'symbol', endpoint),
          options: {
            timeframe: tradingViewTimeframeFromInterval(params.interval),
            range: tradingViewRangeFromParams(params, limit),
            ...tradingViewRecordParam(params, 'options'),
          },
          credentials,
          timeoutMs: tradingViewNumberParam(params, 'timeoutMs'),
        })
        if (candles.error) {
          return { ...candles, endpoint }
        }
        return this.toEnvelope('tradingview', endpoint, {
          totalCount: candles.totalCount,
          rows: candles.rows.map(tradingViewHistoricalRow),
          warnings: candles.warnings,
        }, limit)
      }
      default:
        return errorEnvelope('tradingview', endpoint, `TradingView does not support endpoint '${endpoint}'.`)
    }
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

}

/**
 * Create a MarketDataService with default dependencies.
 *
 * For production use, this creates fresh instances of registry, executor,
 * and router. For testing, pass a partial deps object to override specific
 * dependencies while keeping the rest as defaults.
 *
 * @param deps - Optional dependency overrides for testing or customization
 * @returns Configured MarketDataService instance
 *
 * @example
 * // Production: use defaults
 * const service = createMarketDataService()
 *
 * @example
 * // Testing: inject mock registry
 * const service = createMarketDataService({
 *   registry: mockRegistry,
 *   credentialsForConfig: () => ({ api_key: 'test' })
 * })
 */
export function createMarketDataService(deps?: Partial<MarketDataServiceDeps>): MarketDataService {
  return new MarketDataService({
    executor: deps?.executor ?? createExecutor(),
    registry: deps?.registry ?? createRegistry(),
    router: deps?.router ?? loadAllRouters(),
    readConfig: deps?.readConfig ?? readMarketDataConfig,
    credentialsForConfig: deps?.credentialsForConfig ?? buildSDKCredentials,
    createTradingViewRealtimeClient: deps?.createTradingViewRealtimeClient,
  })
}
