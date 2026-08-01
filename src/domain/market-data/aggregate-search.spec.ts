import { describe, expect, it, vi } from 'vitest'

import { aggregateSymbolSearch, type MarketSearchDeps } from './aggregate-search.js'

function deps(over: Partial<MarketSearchDeps> = {}): MarketSearchDeps {
  return {
    symbolIndex: {
      search: vi.fn(() => [
        { symbol: 'UNRELATED1', name: 'Unrelated One', source: 'sec' },
        { symbol: 'UNRELATED2', name: 'Unrelated Two', source: 'sec' },
        { symbol: 'UNRELATED3', name: 'Unrelated Three', source: 'sec' },
      ]),
    } as never,
    equityVendors: ['yfinance'],
    assetProviders: { crypto: 'yfinance', currency: 'yfinance' },
    equityClient: { search: vi.fn(async () => []) } as never,
    cryptoClient: { search: vi.fn(async () => []) } as never,
    currencyClient: {
      search: vi.fn(async () => [
        { symbol: 'EURUSD', name: 'Euro / U.S. Dollar' },
        { symbol: 'EURUSDX', name: 'Euro Index' },
      ]),
    } as never,
    commodityCatalog: { search: vi.fn(() => []) } as never,
    ...over,
  }
}

describe('aggregateSymbolSearch limits', () => {
  it('ranks the full union, then enforces one global result limit', async () => {
    const searchDeps = deps()
    const results = await aggregateSymbolSearch(searchDeps, 'EURUSD', 2)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ symbol: 'EURUSD', assetClass: 'currency' })
    expect(searchDeps.symbolIndex.search).toHaveBeenCalledWith('EURUSD', 2)
    expect(searchDeps.commodityCatalog.search).toHaveBeenCalledWith('EURUSD', 2)
  })
})

describe('aggregateSymbolSearch', () => {
  it('uses configured crypto and currency providers and preserves sourceId', async () => {
    const cryptoSearch = vi.fn(async () => [{ symbol: 'BINANCE:BTCUSDT', name: 'Bitcoin / TetherUS' }])
    const currencySearch = vi.fn(async () => [{ symbol: 'FX:USDJPY', name: 'U.S. Dollar / Japanese Yen' }])

    const out = await aggregateSymbolSearch(deps({
      symbolIndex: { search: () => [] } as never,
      assetProviders: { crypto: 'fmp', currency: 'fmp' },
      cryptoClient: { search: cryptoSearch } as never,
      currencyClient: { search: currencySearch } as never,
    }), 'USD')

    expect(cryptoSearch).toHaveBeenCalledWith({ query: 'USD', provider: 'fmp' })
    expect(currencySearch).toHaveBeenCalledWith({ query: 'USD', provider: 'fmp' })
    expect(out).toEqual([
      expect.objectContaining({ symbol: 'BINANCE:BTCUSDT', assetClass: 'crypto', sourceId: 'fmp' }),
      expect.objectContaining({ symbol: 'FX:USDJPY', assetClass: 'currency', sourceId: 'fmp' }),
    ])
  })
})
