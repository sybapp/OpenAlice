import { describe, expect, it, vi } from 'vitest'
import { Provider, QueryExecutor, Registry, Router, type CommandHandler } from '@traderalice/opentypebb'
import { MarketDataService } from './service.js'
import type { MarketDataConfig, MarketDataServiceDeps } from './types.js'

const config: MarketDataConfig = {
  providers: {
    equity: 'yfinance',
    crypto: 'yfinance',
    currency: 'yfinance',
    commodity: 'yfinance',
  },
  providerKeys: {
    fmp: 'fmp-key',
  },
}

function deps(
  handler: CommandHandler,
  readConfig: MarketDataServiceDeps['readConfig'] = () => config,
): MarketDataServiceDeps {
  const registry = new Registry()
  registry.includeProvider(new Provider({
    name: 'yfinance',
    description: 'Yahoo Finance',
    fetcherDict: {
      EquitySearch: class {
        static requireCredentials = false
        static transformQuery(params: Record<string, unknown>) { return params }
        static async extractData() { return [] }
        static transformData(_query: unknown, data: unknown) { return data }
        static async fetchData() { return [] }
      },
      EquityHistorical: class {
        static requireCredentials = false
        static transformQuery(params: Record<string, unknown>) { return params }
        static async extractData() { return [] }
        static transformData(_query: unknown, data: unknown) { return data }
        static async fetchData() { return [] }
      },
    },
  }))
  registry.includeProvider(new Provider({
    name: 'tradingview',
    description: 'TradingView',
    fetcherDict: {},
  }))

  const router = new Router()
  router.command({
    model: 'EquitySearch',
    path: '/equity/search',
    description: 'Search equities.',
    handler,
  })
  router.command({
    model: 'EquityHistorical',
    path: '/equity/price/historical',
    description: 'Get equity history.',
    handler,
  })

  return {
    executor: new QueryExecutor(registry),
    registry,
    router,
    readConfig,
    credentialsForConfig: () => ({ fmp_api_key: 'fmp-key' }),
  }
}

describe('MarketDataService', () => {
  it('catalogs router endpoints with provider support', () => {
    const service = new MarketDataService(deps(async () => []))

    const catalog = service.catalog()

    expect(catalog.providers.map((provider) => provider.name)).toEqual(['tradingview', 'yfinance'])
    expect(catalog.endpoints).toContainEqual({
      endpoint: '/equity/search',
      model: 'EquitySearch',
      description: 'Search equities.',
      providers: ['yfinance'],
    })
  })

  it('queries a router endpoint using the configured default provider', async () => {
    const handler = vi.fn(async (_executor, provider, params, credentials) => [
      { symbol: params.query, provider, credential: credentials?.fmp_api_key },
    ])
    const service = new MarketDataService(deps(handler))

    const result = await service.query({
      endpoint: '/equity/search',
      params: { query: 'AAPL' },
    })

    expect(handler).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      provider: 'yfinance',
      endpoint: '/equity/search',
      totalCount: 1,
      fields: ['symbol', 'provider', 'credential'],
      rows: [{ symbol: 'AAPL', provider: 'yfinance', credential: 'fmp-key' }],
    })
    expect(result.error).toBeUndefined()
  })

  it('honors explicit provider override without fallback', async () => {
    const handler = vi.fn<CommandHandler>(async () => {
      throw new Error('Fetcher not found for model')
    })
    const service = new MarketDataService(deps(handler))

    const result = await service.search({
      assetClass: 'equity',
      query: 'MSFT',
      provider: 'fmp',
    })

    expect(handler.mock.calls[0]?.[1]).toBe('fmp')
    expect(result.provider).toBe('fmp')
    expect(result.rows).toEqual([])
    expect(result.error).toBe('Fetcher not found for model')
  })

  it('enforces the default and maximum row limit', async () => {
    const rows = Array.from({ length: 700 }, (_, index) => ({ index }))
    const service = new MarketDataService(deps(async () => rows))

    const defaultLimited = await service.query({ endpoint: '/equity/search' })
    const maxLimited = await service.query({ endpoint: '/equity/search', limit: 600 })
    const small = await service.query({ endpoint: '/equity/search', limit: 2 })

    expect(defaultLimited.rows).toHaveLength(500)
    expect(maxLimited.rows).toHaveLength(500)
    expect(small.rows).toEqual([{ index: 0 }, { index: 1 }])
    expect(maxLimited.totalCount).toBe(700)
  })

  it('wraps historical as the expected endpoint with symbol params', async () => {
    const handler = vi.fn(async (_executor, _provider, params) => [{ symbol: params.symbol }])
    const service = new MarketDataService(deps(handler))

    const result = await service.historical({
      assetClass: 'equity',
      symbol: 'NVDA',
      params: { start_date: '2024-01-01' },
    })

    expect(handler.mock.calls[0]?.[2]).toEqual({ symbol: 'NVDA', start_date: '2024-01-01' })
    expect(result.endpoint).toBe('/equity/price/historical')
  })

  it('returns a boundary error for unsupported search asset classes', async () => {
    const service = new MarketDataService(deps(async () => []))

    const result = await service.search({
      assetClass: 'commodity',
      query: 'gold',
    })

    expect(result.error).toBe("Search is not supported for asset class 'commodity'.")
    expect(result.rows).toEqual([])
  })

  it('scans TradingView preset payloads through fetch and normalizes rows', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        totalCount: 2,
        data: [
          { s: 'NASDAQ:AAPL', d: ['Apple', 190] },
          { s: 'NASDAQ:MSFT', d: ['Microsoft', 420] },
        ],
      }),
    })) as unknown as typeof fetch

    const result = await service.scan({
      preset: 'stocks',
      limit: 1,
      fetch: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.provider).toBe('tradingview')
    expect(result.totalCount).toBe(2)
    expect(result.rows).toEqual([{ ticker: 'NASDAQ:AAPL', name: 'Apple', close: 190 }])
  })

  it('requires a TradingView query payload for query/raw scan modes', async () => {
    const service = new MarketDataService(deps(async () => []))

    const result = await service.scan({ mode: 'query' })

    expect(result.error).toBe('TradingView query scan requires a query payload.')
  })
})
