import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarketDataTools } from './market-data.js'
import type { MarketDataEnvelope } from '@/services/market-data/index.js'

const envelope: MarketDataEnvelope = {
  provider: 'provider-a',
  endpoint: '/equity/search',
  totalCount: 1,
  fields: ['symbol'],
  rows: [{ symbol: 'AAPL' }],
  warnings: [],
}

function makeService() {
  return {
    catalog: vi.fn(() => ({
      providers: [{ name: 'provider-a', description: 'Provider A', credentials: [], models: [] }],
      endpoints: [{ endpoint: '/equity/search', model: 'EquitySearch', description: 'Search', providers: ['provider-a'] }],
    })),
    query: vi.fn(async () => envelope),
    indicator: vi.fn(async () => ({ value: 144.5, dataRange: { AAPL: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-31', bars: 20 } } })),
    scan: vi.fn(async () => ({ ...envelope, endpoint: '/scan', provider: 'tradingview' })),
    search: vi.fn(async () => envelope),
    searchTradingViewSymbols: vi.fn(async () => ({ ...envelope, endpoint: '/tradingview/symbol-search', provider: 'tradingview' })),
    technicalAnalysis: vi.fn(async () => ({ ...envelope, endpoint: '/technical-analysis', provider: 'tradingview' })),
    searchTradingViewIndicators: vi.fn(async () => ({ ...envelope, endpoint: '/tradingview/indicator-search', provider: 'tradingview' })),
    getTradingViewIndicator: vi.fn(async () => ({ ...envelope, endpoint: '/tradingview/indicator', provider: 'tradingview' })),
  }
}

const exec = (t: any, args: unknown = {}) => (t.execute as Function)(args)

describe('createMarketDataTools', () => {
  let service: ReturnType<typeof makeService>
  let tools: ReturnType<typeof createMarketDataTools>

  beforeEach(() => {
    service = makeService()
    tools = createMarketDataTools(service)
  })

  it('exposes generic market-data tools plus indicator calculation', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'marketDataCatalog',
      'marketDataIndicator',
      'marketDataQuery',
      'marketDataScan',
      'marketDataSearch',
      'tradingViewIndicatorGet',
      'tradingViewIndicatorSearch',
      'tradingViewSymbolSearch',
      'tradingViewTechnicalAnalysis',
    ])
  })

  it('marketDataCatalog returns the service catalog unchanged', async () => {
    const result = await exec(tools.marketDataCatalog)
    expect(result).toBe(service.catalog.mock.results[0]?.value)
    expect(service.catalog).toHaveBeenCalledWith()
  })

  it('marketDataQuery forwards object params and returns the service envelope unchanged', async () => {
    const result = await exec(tools.marketDataQuery, {
      endpoint: '/equity/price/historical',
      provider: 'fmp',
      params: { symbol: 'AAPL' },
      limit: 5,
      credentials: { fmp_api_key: 'secret' },
    })

    expect(result).toBe(envelope)
    expect(service.query).toHaveBeenCalledWith({
      endpoint: '/equity/price/historical',
      provider: 'fmp',
      params: { symbol: 'AAPL' },
      limit: 5,
      credentials: { fmp_api_key: 'secret' },
    })
  })

  it('marketDataQuery parses CLI JSON-string params and credentials', async () => {
    await exec(tools.marketDataQuery, {
      endpoint: 'equity/search',
      params: '{"query":"apple"}',
      credentials: '{"provider_key":"secret"}',
    })

    expect(service.query).toHaveBeenCalledWith({
      endpoint: 'equity/search',
      provider: undefined,
      params: { query: 'apple' },
      limit: undefined,
      credentials: { provider_key: 'secret' },
    })
  })

  it('marketDataScan forwards preset scan inputs', async () => {
    await exec(tools.marketDataScan, {
      preset: 'stocks',
      market: 'america',
      limit: 25,
    })

    expect(service.scan).toHaveBeenCalledWith({
      provider: undefined,
      mode: undefined,
      preset: 'stocks',
      market: 'america',
      query: undefined,
      limit: 25,
      credentials: undefined,
    })
  })

  it('marketDataScan parses custom query JSON strings', async () => {
    await exec(tools.marketDataScan, {
      mode: 'query',
      query: '{"columns":["name","close"],"filter":[{"left":"close","operation":"greater","right":100}]}',
      credentials: null,
    })

    expect(service.scan).toHaveBeenCalledWith({
      provider: undefined,
      mode: 'query',
      preset: undefined,
      market: undefined,
      query: {
        columns: ['name', 'close'],
        filter: [{ left: 'close', operation: 'greater', right: 100 }],
      },
      limit: undefined,
      credentials: null,
    })
  })

  it('marketDataSearch forwards search input and parses extra params', async () => {
    await exec(tools.marketDataSearch, {
      assetClass: 'equity',
      query: 'apple',
      provider: 'sec',
      limit: 10,
      params: '{"is_symbol":false}',
    })

    expect(service.search).toHaveBeenCalledWith({
      assetClass: 'equity',
      query: 'apple',
      provider: 'sec',
      limit: 10,
      params: { is_symbol: false },
      credentials: undefined,
    })
  })

  it('marketDataIndicator forwards calculation input and parses credentials', async () => {
    const result = await exec(tools.marketDataIndicator, {
      asset: 'equity',
      formula: "SMA(CLOSE('AAPL', '1d'), 20)",
      precision: 2,
      provider: 'fmp',
      credentials: '{"fmp_api_key":"secret"}',
    })

    expect(result).toEqual({
      value: 144.5,
      dataRange: { AAPL: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-31', bars: 20 } },
    })
    expect(service.indicator).toHaveBeenCalledWith({
      asset: 'equity',
      formula: "SMA(CLOSE('AAPL', '1d'), 20)",
      precision: 2,
      provider: 'fmp',
      credentials: { fmp_api_key: 'secret' },
    })
  })

  it('tradingViewSymbolSearch forwards symbol lookup input', async () => {
    await exec(tools.tradingViewSymbolSearch, {
      query: 'nasdaq:aapl',
      type: 'stock',
      offset: 5,
      limit: 10,
      credentials: '{"tradingview_sessionid":"session"}',
    })

    expect(service.searchTradingViewSymbols).toHaveBeenCalledWith({
      query: 'nasdaq:aapl',
      type: 'stock',
      offset: 5,
      limit: 10,
      credentials: { tradingview_sessionid: 'session' },
    })
  })

  it('tradingViewTechnicalAnalysis forwards TA input', async () => {
    await exec(tools.tradingViewTechnicalAnalysis, {
      symbol: 'NASDAQ:AAPL',
      periods: ['1D', '1W'],
      credentials: '{"tradingview_sessionid":"session","tradingview_sessionid_sign":"sign"}',
    })

    expect(service.technicalAnalysis).toHaveBeenCalledWith({
      symbol: 'NASDAQ:AAPL',
      periods: ['1D', '1W'],
      credentials: { tradingview_sessionid: 'session', tradingview_sessionid_sign: 'sign' },
    })
  })

  it('tradingViewIndicatorSearch forwards indicator discovery input', async () => {
    await exec(tools.tradingViewIndicatorSearch, {
      query: 'RSI',
      includeBuiltIn: true,
      limit: 25,
      credentials: '{"tradingview_sessionid":"session"}',
    })

    expect(service.searchTradingViewIndicators).toHaveBeenCalledWith({
      query: 'RSI',
      includeBuiltIn: true,
      limit: 25,
      credentials: { tradingview_sessionid: 'session' },
    })
  })

  it('tradingViewIndicatorGet forwards indicator metadata input', async () => {
    await exec(tools.tradingViewIndicatorGet, {
      id: 'PUB;abc',
      version: 'last',
      credentials: '{"tradingview_sessionid":"session"}',
    })

    expect(service.getTradingViewIndicator).toHaveBeenCalledWith({
      id: 'PUB;abc',
      version: 'last',
      credentials: { tradingview_sessionid: 'session' },
    })
  })

  it('schemas reject unsupported search asset classes and scan presets', () => {
    expect((tools.marketDataSearch as any).inputSchema.safeParse({ assetClass: 'economy', query: 'GDP' }).success).toBe(false)
    expect((tools.marketDataScan as any).inputSchema.safeParse({ preset: 'unknown' }).success).toBe(false)
    expect((tools.marketDataIndicator as any).inputSchema.safeParse({ asset: 'etf', formula: '1 + 1' }).success).toBe(false)
  })

  it('throws a clear error for invalid JSON-string object flags', async () => {
    await expect(exec(tools.marketDataQuery, {
      endpoint: '/equity/search',
      params: '[1,2,3]',
    })).rejects.toThrow('params must be a JSON object string')
  })
})
