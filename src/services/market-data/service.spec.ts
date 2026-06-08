import { describe, expect, it, vi } from 'vitest'
import {
  Provider,
  QueryExecutor,
  Registry,
  Router,
  TradingViewRealtimeClient,
  formatRealtimeCommand,
  parseRealtimeFrames,
  type CommandHandler,
  type TradingViewRealtimeClientOptions,
  type TradingViewRealtimeSocket,
} from '@traderalice/opentypebb'
import { MarketDataService } from './service.js'
import type { MarketDataConfig, MarketDataServiceDeps } from './types.js'

const config: MarketDataConfig = {
  providers: {
    equity: 'yfinance',
    crypto: 'yfinance',
    currency: 'yfinance',
    commodity: 'yfinance',
    scanner: 'tradingview',
  },
  providerKeys: {
    fmp: 'fmp-key',
    tradingview_sessionid: 'session-123',
  },
}

function deps(
  handler: CommandHandler,
  readConfig: MarketDataServiceDeps['readConfig'] = () => config,
  overrides: Partial<MarketDataServiceDeps> = {},
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
      CommoditySpotPrice: class {
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
  router.command({
    model: 'CommoditySpotPrice',
    path: '/commodity/price/spot',
    description: 'Get commodity spot prices.',
    handler,
  })

  return {
    executor: new QueryExecutor(registry),
    registry,
    router,
    readConfig,
    credentialsForConfig: () => ({ fmp_api_key: 'fmp-key', tradingview_sessionid: 'session-123' }),
    ...overrides,
  }
}

class FakeRealtimeSocket implements TradingViewRealtimeSocket {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (() => void) | ((event: unknown) => void) | ((event: { data: unknown }) => void),
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<(event?: unknown) => void>()
    listeners.add(listener as (event?: unknown) => void)
    this.listeners.set(type, listeners)
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  message(data: string): void {
    this.emit('message', { data })
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
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

  it('calculates indicators through the generic historical path with stable filtering and metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T12:00:00Z'))
    const handler = vi.fn(async (_executor, _provider, params) => {
      expect(params).toEqual({ symbol: 'AAPL', start_date: '2024-06-07', interval: '1d' })
      return [
        { date: '2024-06-09', open: 3, high: 4, low: 2, close: 3, volume: null },
        { date: '2024-06-08', open: null, high: 2, low: 1, close: 2, volume: 20 },
        { date: '2024-06-07', open: 1, high: 2, low: 0, close: 1, volume: 10 },
      ]
    })
    const service = new MarketDataService(deps(handler))

    try {
      const result = await service.indicator({
        asset: 'equity',
        formula: "CLOSE('AAPL', '1d')",
      })

      expect(result).toEqual({
        value: [1, 3],
        dataRange: {
          AAPL: { symbol: 'AAPL', from: '2024-06-07', to: '2024-06-09', bars: 2 },
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('calculates commodity indicators through spot prices without forwarding interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T12:00:00Z'))
    const handler = vi.fn(async (_executor, _provider, params) => {
      expect(params).toEqual({ symbol: 'gold', start_date: '2024-06-07' })
      return [
        { date: '2024-06-07', open: 100, high: 101, low: 99, close: 100, volume: null },
        { date: '2024-06-08', open: 102, high: 103, low: 101, close: 102, volume: null },
      ]
    })
    const service = new MarketDataService(deps(handler))

    try {
      const result = await service.indicator({
        asset: 'commodity',
        formula: "CLOSE('gold', '1d')[-1]",
      })

      expect(result.value).toBe(102)
      expect(result.dataRange.gold).toEqual({ symbol: 'gold', from: '2024-06-07', to: '2024-06-08', bars: 2 })
    } finally {
      vi.useRealTimers()
    }
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

  it('uses configured scanner provider and credentials for TradingView scans', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalCount: 0, data: [] }),
    })) as unknown as typeof fetch

    await service.scan({
      preset: 'stocks',
      fetch: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: 'sessionid=session-123',
        }),
      }),
    )
  })

  it('requires a TradingView query payload for query/raw scan modes', async () => {
    const service = new MarketDataService(deps(async () => []))

    const result = await service.scan({ mode: 'query' })

    expect(result.error).toBe('TradingView query scan requires a query payload.')
  })

  it('subscribes to TradingView realtime quotes through the unified provider path', async () => {
    const socket = new FakeRealtimeSocket()
    const clientOptions: TradingViewRealtimeClientOptions[] = []
    const updates: unknown[] = []
    const service = new MarketDataService(deps(async () => [], undefined, {
      createTradingViewRealtimeClient: (options) => {
        clientOptions.push(options)
        return new TradingViewRealtimeClient({
          ...options,
          socketFactory: () => socket,
        })
      },
    }))

    const subscription = await service.subscribeQuote({
      symbol: 'NASDAQ:AAPL',
      fields: 'price',
      onData: (data) => updates.push(data),
    })
    socket.open()

    expect(subscription.provider).toBe('tradingview')
    expect(clientOptions[0]?.credentials).toMatchObject({ tradingview_sessionid: 'session-123' })
    expect(socket.sent).toContain(formatRealtimeCommand('set_auth_token', ['unauthorized_user_token']))

    const quoteCreate = socket.sent.find((packet) => packet.includes('quote_create_session'))
    const quoteFrame = quoteCreate ? parseRealtimeFrames(quoteCreate)[0] : null
    const quoteSessionId = quoteFrame && typeof quoteFrame === 'object' && Array.isArray(quoteFrame.p)
      ? String(quoteFrame.p[0])
      : ''
    const key = '= {"session":"regular","symbol":"NASDAQ:AAPL"}'.replace(' ', '')

    expect(socket.sent).toContain(formatRealtimeCommand('quote_set_fields', [quoteSessionId, 'lp']))
    expect(socket.sent).toContain(formatRealtimeCommand('quote_add_symbols', [quoteSessionId, key]))

    socket.message(formatRealtimeCommand('qsd', [
      quoteSessionId,
      { n: key, s: 'ok', v: { lp: 190 } },
    ]))

    expect(updates).toEqual([{ symbol: key, values: { lp: 190 } }])

    subscription.close()
    expect(socket.readyState).toBe(3)
  })

  it('rejects realtime quote subscriptions for non-TradingView providers', async () => {
    const service = new MarketDataService(deps(async () => []))

    await expect(service.subscribeQuote({
      provider: 'yfinance',
      symbol: 'NASDAQ:AAPL',
      onData: () => {},
    })).rejects.toThrow('Only the tradingview provider supports realtime quote subscriptions.')
  })
})
