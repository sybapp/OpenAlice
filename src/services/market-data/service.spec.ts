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
      IncomeStatement: class {
        static requireCredentials = false
        static transformQuery(params: Record<string, unknown>) { return params }
        static async extractData() { return [] }
        static transformData(_query: unknown, data: unknown) { return data }
        static async fetchData() { return [] }
      },
      CalendarEarnings: class {
        static requireCredentials = false
        static transformQuery(params: Record<string, unknown>) { return params }
        static async extractData() { return [] }
        static transformData(_query: unknown, data: unknown) { return data }
        static async fetchData() { return [] }
      },
      CompanyFilings: class {
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
  router.command({
    model: 'IncomeStatement',
    path: '/equity/fundamental/income',
    description: 'Get the income statement for a given company.',
    handler,
  })
  router.command({
    model: 'CalendarEarnings',
    path: '/equity/calendar/earnings',
    description: 'Get company earnings releases.',
    handler,
  })
  router.command({
    model: 'CompanyFilings',
    path: '/equity/fundamental/filings',
    description: 'Get company filings.',
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

function waitForSocketPacket(socket: FakeRealtimeSocket, pattern: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const poll = () => {
      const packet = socket.sent.find((sent) => sent.includes(pattern))
      if (packet) {
        resolve(packet)
        return
      }
      attempts += 1
      if (attempts > 20) {
        reject(new Error(`Timed out waiting for socket packet containing ${pattern}`))
        return
      }
      setTimeout(poll, 0)
    }
    poll()
  })
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

    expect(defaultLimited.rows).toHaveLength(50)
    expect(maxLimited.rows).toHaveLength(500)
    expect(small.rows).toEqual([{ index: 0 }, { index: 1 }])
    expect(maxLimited.totalCount).toBe(700)
  })

  it('searches endpoint catalog without returning the full catalog', async () => {
    const service = new MarketDataService(deps(async () => []))

    const result = await service.endpointSearch({
      query: 'income',
      assetClass: 'equity',
      provider: 'yfinance',
      limit: 5,
    })

    expect(result).toMatchObject({
      provider: 'catalog',
      endpoint: '/catalog/endpoints',
      totalCount: 1,
      rows: [{
        endpoint: '/equity/fundamental/income',
        model: 'IncomeStatement',
        providers: ['yfinance'],
      }],
    })
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

  it('wraps common fundamentals, earnings calendar, and filings endpoints', async () => {
    const handler = vi.fn(async (_executor, _provider, params) => [{ ...params }])
    const service = new MarketDataService(deps(handler))

    await service.fundamentals({
      symbol: 'AAPL',
      statement: 'income',
      period: 'annual',
      params: { fiscal_year: 2025 },
      limit: 3,
    })
    await service.earnings({
      symbol: 'AAPL',
      params: { start_date: '2026-01-01' },
    })
    await service.filings({
      symbol: 'AAPL',
      provider: 'sec',
      params: { form_type: '10-K' },
    })

    expect(handler.mock.calls[0]?.[2]).toEqual({ symbol: 'AAPL', period: 'annual', fiscal_year: 2025 })
    expect(handler.mock.calls[1]?.[2]).toEqual({ symbol: 'AAPL', start_date: '2026-01-01' })
    expect(handler.mock.calls[2]?.[1]).toBe('sec')
    expect(handler.mock.calls[2]?.[2]).toEqual({ symbol: 'AAPL', form_type: '10-K' })
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
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        totalCount: 2,
        data: [
          { s: 'NASDAQ:AAPL', d: ['Apple', 190] },
          { s: 'NASDAQ:MSFT', d: ['Microsoft', 420] },
        ],
      }),
    }))
    const fetchMock = fetchSpy as unknown as typeof fetch

    const result = await service.scan({
      preset: 'stocks',
      limit: 1,
      fetch: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const firstCall = fetchSpy.mock.calls[0] as unknown as [unknown, RequestInit | undefined]
    const request = JSON.parse(String(firstCall[1]?.body))
    expect(request.columns).toEqual([
      'name',
      'close',
      'change',
      'volume',
      'market_cap_basic',
      'currency',
      'type',
      'sector',
      'AnalystRating',
    ])
    expect(result.provider).toBe('tradingview')
    expect(result.totalCount).toBe(2)
    expect(result.rows).toEqual([{ ticker: 'NASDAQ:AAPL', name: 'Apple', close: 190 }])
  })

  it('lets TradingView scans request explicit columns instead of compact defaults', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        totalCount: 1,
        data: [{ s: 'NASDAQ:AAPL', d: ['Apple', 190, 'USD'] }],
      }),
    }))
    const fetchMock = fetchSpy as unknown as typeof fetch

    const result = await service.scan({
      preset: 'stocks',
      columns: ['name', 'close', 'currency'],
      fetch: fetchMock,
    })

    const firstCall = fetchSpy.mock.calls[0] as unknown as [unknown, RequestInit | undefined]
    const request = JSON.parse(String(firstCall[1]?.body))
    expect(request.columns).toEqual(['name', 'close', 'currency'])
    expect(result.rows[0]).toEqual({ ticker: 'NASDAQ:AAPL', name: 'Apple', close: 190, currency: 'USD' })
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

  it('subscribes to TradingView realtime candles through the unified provider path', async () => {
    const socket = new FakeRealtimeSocket()
    const updates: unknown[] = []
    const service = new MarketDataService(deps(async () => [], undefined, {
      createTradingViewRealtimeClient: (options) => new TradingViewRealtimeClient({
        ...options,
        socketFactory: () => socket,
      }),
    }))

    const subscription = await service.subscribeCandles({
      symbol: 'NASDAQ:AAPL',
      options: { timeframe: '60', range: 2 },
      onData: (data) => updates.push(data),
    })
    socket.open()

    const chartCreate = await waitForSocketPacket(socket, 'chart_create_session')
    const chartFrame = chartCreate ? parseRealtimeFrames(chartCreate)[0] : null
    const chartSessionId = chartFrame && typeof chartFrame === 'object' && Array.isArray(chartFrame.p)
      ? String(chartFrame.p[0])
      : ''

    expect(subscription.provider).toBe('tradingview')
    expect(socket.sent).toContain(formatRealtimeCommand('create_series', [
      chartSessionId,
      '$prices',
      's1',
      'ser_1',
      '60',
      2,
    ]))

    socket.message(formatRealtimeCommand('timescale_update', [
      chartSessionId,
      {
        $prices: {
          s: [{ i: 1, v: [1717200000, 190, 195, 189, 194, 123.456] }],
        },
      },
    ]))

    expect(updates).toEqual([{
      symbol: 'NASDAQ:AAPL',
      candles: [{ time: 1717200000, open: 190, high: 195, low: 189, close: 194, volume: 123.46 }],
      changes: ['$prices'],
      marketInfo: null,
    }])
    expect(subscription.getCandles()).toEqual([
      { time: 1717200000, open: 190, high: 195, low: 189, close: 194, volume: 123.46 },
    ])

    subscription.fetchMore(3)
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('request_more_data', [chartSessionId, '$prices', 3]))

    subscription.setTimezone('Asia/Shanghai')
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('switch_timezone', [chartSessionId, 'Asia/Shanghai']))
    expect(subscription.getCandles()).toEqual([])

    subscription.setSeries('1D', 5, 1717200000)
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('modify_series', [
      chartSessionId,
      '$prices',
      's1',
      'ser_1',
      '1D',
      '',
    ]))

    subscription.setMarket('NASDAQ:MSFT', { timeframe: '15', range: 4, replay: 1717200000 })
    const replayCreate = socket.sent.find((packet) => packet.includes('replay_create_session'))
    const replayFrame = replayCreate ? parseRealtimeFrames(replayCreate)[0] : null
    const replaySessionId = replayFrame && typeof replayFrame === 'object' && Array.isArray(replayFrame.p)
      ? String(replayFrame.p[0])
      : ''

    const stepPromise = subscription.replayStep(2)
    const stepFrame = parseRealtimeFrames(socket.sent.at(-1) ?? '')[0]
    const stepRequest = stepFrame && typeof stepFrame === 'object' && Array.isArray(stepFrame.p)
      ? String(stepFrame.p[1])
      : ''
    socket.message(formatRealtimeCommand('replay_ok', [replaySessionId, stepRequest]))
    await expect(stepPromise).resolves.toBeUndefined()

    subscription.close()
    expect(socket.readyState).toBe(3)
  })

  it('gets a one-shot TradingView candle snapshot through the service layer', async () => {
    const socket = new FakeRealtimeSocket()
    const service = new MarketDataService(deps(async () => [], undefined, {
      createTradingViewRealtimeClient: (options) => new TradingViewRealtimeClient({
        ...options,
        socketFactory: () => socket,
      }),
    }))

    const resultPromise = service.tradingViewCandles({
      symbol: 'NASDAQ:AAPL',
      options: { timeframe: '60', range: 2 },
    })
    socket.open()

    const chartCreate = await waitForSocketPacket(socket, 'chart_create_session')
    const chartFrame = chartCreate ? parseRealtimeFrames(chartCreate)[0] : null
    const chartSessionId = chartFrame && typeof chartFrame === 'object' && Array.isArray(chartFrame.p)
      ? String(chartFrame.p[0])
      : ''

    socket.message(formatRealtimeCommand('timescale_update', [
      chartSessionId,
      {
        $prices: {
          s: [
            { i: 1, v: [1717200000, 190, 195, 189, 194, 123.456] },
            { i: 2, v: [1717203600, 194, 196, 193, 195, 456] },
          ],
        },
      },
    ]))

    await expect(resultPromise).resolves.toEqual({
      provider: 'tradingview',
      endpoint: '/tradingview/candles',
      totalCount: 2,
      fields: ['symbol', 'time', 'open', 'high', 'low', 'close', 'volume', 'timeISO', 'marketInfo'],
      rows: [
        { symbol: 'NASDAQ:AAPL', time: 1717200000, open: 190, high: 195, low: 189, close: 194, volume: 123.46, timeISO: '2024-06-01T00:00:00.000Z', marketInfo: null },
        { symbol: 'NASDAQ:AAPL', time: 1717203600, open: 194, high: 196, low: 193, close: 195, volume: 456, timeISO: '2024-06-01T01:00:00.000Z', marketInfo: null },
      ],
      warnings: ['TradingView chart update: $prices'],
    })
    expect(socket.readyState).toBe(3)
  })

  it('gets a one-row TradingView quote snapshot from the latest candle', async () => {
    const socket = new FakeRealtimeSocket()
    const service = new MarketDataService(deps(async () => [], undefined, {
      createTradingViewRealtimeClient: (options) => new TradingViewRealtimeClient({
        ...options,
        socketFactory: () => socket,
      }),
    }))

    const resultPromise = service.tradingViewQuote({ symbol: 'CBOE:DRAM' })
    socket.open()

    const chartCreate = await waitForSocketPacket(socket, 'chart_create_session')
    const chartFrame = chartCreate ? parseRealtimeFrames(chartCreate)[0] : null
    const chartSessionId = chartFrame && typeof chartFrame === 'object' && Array.isArray(chartFrame.p)
      ? String(chartFrame.p[0])
      : ''

    const createSeries = await waitForSocketPacket(socket, 'create_series')
    expect(createSeries).toContain('"1D"')
    expect(createSeries).toContain(',2]')

    socket.message(formatRealtimeCommand('timescale_update', [
      chartSessionId,
      {
        $prices: {
          s: [
            { i: 1, v: [1717200000, 70, 72, 69, 71, 1000] },
            { i: 2, v: [1717286400, 71, 73, 70, 72.5, 1200] },
          ],
        },
      },
    ]))

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'tradingview',
      endpoint: '/tradingview/quote',
      totalCount: 1,
      rows: [{
        symbol: 'CBOE:DRAM',
        price: 72.5,
        close: 72.5,
        timeISO: '2024-06-02T00:00:00.000Z',
        source: '/tradingview/candles',
      }],
    })
  })

  it('runs a one-shot TradingView study and returns parsed values', async () => {
    const socket = new FakeRealtimeSocket()
    const service = new MarketDataService(deps(async () => [], undefined, {
      createTradingViewRealtimeClient: (options) => new TradingViewRealtimeClient({
        ...options,
        socketFactory: () => socket,
      }),
    }))

    const resultPromise = service.runTradingViewStudy({
      symbol: 'NASDAQ:AAPL',
      options: { timeframe: '60', range: 2 },
      builtInType: 'Volume@tv-basicstudies-241',
      inputs: { length: 10 },
    })
    socket.open()

    const chartCreate = await waitForSocketPacket(socket, 'chart_create_session')
    const chartFrame = chartCreate ? parseRealtimeFrames(chartCreate)[0] : null
    const chartSessionId = chartFrame && typeof chartFrame === 'object' && Array.isArray(chartFrame.p)
      ? String(chartFrame.p[0])
      : ''
    const createStudy = await waitForSocketPacket(socket, 'create_study')
    const studyFrame = createStudy ? parseRealtimeFrames(createStudy)[0] : null
    const studyId = studyFrame && typeof studyFrame === 'object' && Array.isArray(studyFrame.p)
      ? String(studyFrame.p[1])
      : ''

    expect(createStudy).toContain('Volume@tv-basicstudies-241')
    expect(createStudy).toContain('"length":10')

    socket.message(formatRealtimeCommand('timescale_update', [
      chartSessionId,
      {
        $prices: {
          s: [{ i: 1, v: [1717200000, 190, 195, 189, 194, 123] }],
        },
      },
    ]))
    socket.message(formatRealtimeCommand('timescale_update', [
      chartSessionId,
      {
        [studyId]: {
          st: [
            { v: [1717200000, 123] },
            { v: [1717203600, 456] },
          ],
        },
      },
    ]))

    const result = await resultPromise
    expect(result.provider).toBe('tradingview')
    expect(result.endpoint).toBe('/tradingview/study')
    expect(result.totalCount).toBe(2)
    expect(result.rows).toEqual([{
      symbol: 'NASDAQ:AAPL',
      candles: [{ symbol: 'NASDAQ:AAPL', time: 1717200000, open: 190, high: 195, low: 189, close: 194, volume: 123, timeISO: '2024-06-01T00:00:00.000Z', marketInfo: undefined }],
      points: [
        { $time: 1717200000, plot_0: 123, $timeISO: '2024-06-01T00:00:00.000Z' },
        { $time: 1717203600, plot_0: 456, $timeISO: '2024-06-01T01:00:00.000Z' },
      ],
      graphics: {
        labels: [],
        lines: [],
        boxes: [],
        tables: [],
        horizLines: [],
        polygons: [],
        horizHists: [],
        raw: {},
      },
      strategyReport: { trades: [], history: {} },
      changes: ['plots'],
    }])
    expect(socket.readyState).toBe(3)
  })

  it('runs a TradingView study from an indicator reference', async () => {
    const socket = new FakeRealtimeSocket()
    const service = new MarketDataService(deps(async () => [], undefined, {
      createTradingViewRealtimeClient: (options) => new TradingViewRealtimeClient({
        ...options,
        socketFactory: () => socket,
      }),
    }))

    const resultPromise = service.runTradingViewStudy({
      symbol: 'NASDAQ:AAPL',
      indicator: { id: 'Volume@tv-basicstudies-241', version: 'last' },
    })
    socket.open()

    const chartCreate = await waitForSocketPacket(socket, 'chart_create_session')
    const chartFrame = chartCreate ? parseRealtimeFrames(chartCreate)[0] : null
    const chartSessionId = chartFrame && typeof chartFrame === 'object' && Array.isArray(chartFrame.p)
      ? String(chartFrame.p[0])
      : ''
    const createStudy = await waitForSocketPacket(socket, 'create_study')
    const studyFrame = createStudy ? parseRealtimeFrames(createStudy)[0] : null
    const studyId = studyFrame && typeof studyFrame === 'object' && Array.isArray(studyFrame.p)
      ? String(studyFrame.p[1])
      : ''

    expect(createStudy).toContain('Volume@tv-basicstudies-241')
    socket.message(formatRealtimeCommand('timescale_update', [
      chartSessionId,
      {
        [studyId]: {
          st: [{ v: [1717200000, 100] }],
        },
      },
    ]))

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'tradingview',
      endpoint: '/tradingview/study',
      rows: [{
        symbol: 'NASDAQ:AAPL',
        points: [{ $time: 1717200000, plot_0: 100, $timeISO: '2024-06-01T00:00:00.000Z' }],
      }],
    })
  })

  it('rejects realtime candle subscriptions for non-TradingView providers', async () => {
    const service = new MarketDataService(deps(async () => []))

    await expect(service.subscribeCandles({
      provider: 'yfinance',
      symbol: 'NASDAQ:AAPL',
      onData: () => {},
    })).rejects.toThrow('Only the tradingview provider supports realtime candle subscriptions.')
  })

  it('searches TradingView symbols through the service layer', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        symbols: [
          {
            prefix: 'NASDAQ',
            exchange: 'NASDAQ Global Select',
            symbol: 'AAPL',
            description: 'Apple Inc.',
            type: 'stock',
          },
          {
            prefix: 'NYSE',
            exchange: 'NYSE',
            symbol: 'A',
            description: 'Agilent',
            type: 'stock',
          },
        ],
      }),
    })) as unknown as typeof fetch

    const result = await service.searchTradingViewSymbols({
      query: 'AAPL',
      type: 'stock',
      limit: 1,
      fetch: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://symbol-search.tradingview.com/symbol_search/v3?'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          cookie: 'sessionid=session-123',
        }),
      }),
    )
    expect(result).toEqual({
      provider: 'tradingview',
      endpoint: '/tradingview/symbol-search',
      totalCount: 2,
      fields: ['id', 'exchange', 'fullExchange', 'symbol', 'description', 'type'],
      rows: [{
        id: 'NASDAQ:AAPL',
        exchange: 'NASDAQ',
        fullExchange: 'NASDAQ Global Select',
        symbol: 'AAPL',
        description: 'Apple Inc.',
        type: 'stock',
      }],
      warnings: [],
    })
  })

  it('rejects TradingView symbol search for non-TradingView providers', async () => {
    const service = new MarketDataService(deps(async () => []))

    const result = await service.searchTradingViewSymbols({
      provider: 'yfinance',
      query: 'AAPL',
    })

    expect(result.provider).toBe('yfinance')
    expect(result.rows).toEqual([])
    expect(result.error).toBe('Only the tradingview provider supports TradingView symbol search at the service layer.')
  })

  it('searches TradingView indicators through the service layer', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('pine-facade/list')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        results: [{
          scriptIdPart: 'PUB;abc',
          version: '1',
          scriptName: 'Community RSI',
          author: { id: 10, username: 'alice' },
          access: 1,
          extra: { kind: 'study' },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const result = await service.searchTradingViewIndicators({
      query: 'RSI',
      includeBuiltIn: false,
      fetch: fetchMock,
    })

    expect(result).toEqual({
      provider: 'tradingview',
      endpoint: '/tradingview/indicator-search',
      totalCount: 1,
      fields: ['id', 'version', 'name', 'author', 'image', 'access', 'source', 'type'],
      rows: [{
        id: 'PUB;abc',
        version: '1',
        name: 'Community RSI',
        author: { id: 10, username: 'alice' },
        image: '',
        access: 'open_source',
        source: '',
        type: 'study',
      }],
      warnings: [],
    })
  })

  it('gets TradingView indicator metadata through the service layer', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        ilTemplate: 'pine bytecode',
        metaInfo: {
          scriptIdPart: 'PUB;abc',
          description: 'Super Trend',
          shortDescription: 'ST',
          pine: { version: '5' },
          inputs: [{ id: 'in_Factor', name: 'Factor', type: 'float', defval: 3 }],
          styles: { plot_0: { title: 'Trend' } },
          plots: [],
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const result = await service.getTradingViewIndicator({
      id: 'PUB;abc',
      fetch: fetchMock,
    })

    expect(result.provider).toBe('tradingview')
    expect(result.endpoint).toBe('/tradingview/indicator')
    expect(result.totalCount).toBe(1)
    expect(result.rows[0]).toMatchObject({
      id: 'PUB;abc',
      version: '5',
      description: 'Super Trend',
      shortDescription: 'ST',
      type: 'Script@tv-scripting-101!',
      script: 'pine bytecode',
      plots: { plot_0: 'Trend' },
    })
    expect(result.rows[0]?.['inputs']).toMatchObject({
      in_Factor: {
        name: 'Factor',
        value: 3,
      },
    })
  })

  it('rejects TradingView indicator metadata for non-TradingView providers', async () => {
    const service = new MarketDataService(deps(async () => []))

    const search = await service.searchTradingViewIndicators({ provider: 'yfinance' })
    const metadata = await service.getTradingViewIndicator({ provider: 'yfinance', id: 'PUB;abc' })

    expect(search.error).toBe('Only the tradingview provider supports TradingView indicator search at the service layer.')
    expect(metadata.error).toBe('Only the tradingview provider supports TradingView indicator metadata at the service layer.')
  })

  it('gets TradingView technical analysis through the service layer', async () => {
    const service = new MarketDataService(deps(async () => []))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        totalCount: 1,
        data: [{ s: 'NASDAQ:AAPL', d: [0.1, 0.2, 0.3] }],
      }),
    })) as unknown as typeof fetch

    const result = await service.technicalAnalysis({
      symbol: 'NASDAQ:AAPL',
      periods: ['1D'],
      fetch: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://scanner.tradingview.com/global/scan',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          cookie: 'sessionid=session-123',
        }),
      }),
    )
    expect(result).toEqual({
      provider: 'tradingview',
      endpoint: '/technical-analysis',
      totalCount: 1,
      fields: ['symbol', 'period', 'Other', 'All', 'MA'],
      rows: [{ symbol: 'NASDAQ:AAPL', period: '1D', Other: 0.2, All: 0.4, MA: 0.6 }],
      warnings: [],
    })
  })

  it('rejects technical analysis for non-TradingView providers', async () => {
    const service = new MarketDataService(deps(async () => []))

    const result = await service.technicalAnalysis({
      provider: 'yfinance',
      symbol: 'NASDAQ:AAPL',
    })

    expect(result.provider).toBe('yfinance')
    expect(result.rows).toEqual([])
    expect(result.error).toBe('Only the tradingview provider supports technical analysis at the service layer.')
  })
})
