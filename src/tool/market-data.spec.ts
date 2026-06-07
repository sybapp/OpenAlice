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
    scan: vi.fn(async () => ({ ...envelope, endpoint: '/scan', provider: 'tradingview' })),
    search: vi.fn(async () => envelope),
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

  it('exposes only the read-only generic market-data tools for Task 3', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'marketDataCatalog',
      'marketDataQuery',
      'marketDataScan',
      'marketDataSearch',
    ])
    expect('marketDataIndicator' in tools).toBe(false)
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

  it('schemas reject unsupported search asset classes and scan presets', () => {
    expect((tools.marketDataSearch as any).inputSchema.safeParse({ assetClass: 'economy', query: 'GDP' }).success).toBe(false)
    expect((tools.marketDataScan as any).inputSchema.safeParse({ preset: 'unknown' }).success).toBe(false)
  })

  it('throws a clear error for invalid JSON-string object flags', async () => {
    await expect(exec(tools.marketDataQuery, {
      endpoint: '/equity/search',
      params: '[1,2,3]',
    })).rejects.toThrow('params must be a JSON object string')
  })
})
