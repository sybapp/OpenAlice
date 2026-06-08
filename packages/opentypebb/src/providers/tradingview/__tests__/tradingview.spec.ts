import { describe, expect, it, vi } from 'vitest'

import { createRegistry } from '../../../core/api/app-loader.js'
import {
  And,
  Column,
  DEFAULT_RANGE,
  OPTIONS_SCAN2_URL,
  Or,
  Query,
  getTechnicalAnalysis,
  bond,
  cfd,
  coin,
  col,
  crypto,
  cryptoDex,
  forex,
  futures,
  options,
  searchSymbols,
  stocks,
} from '../index.js'

function mockFetch(json: unknown, capture: Array<{ url: string; init: RequestInit }> = []) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    capture.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function parseBody(init: RequestInit): unknown {
  return JSON.parse(String(init.body))
}

describe('TradingView Query payload parity', () => {
  it('matches the Python default america stock query shape', () => {
    const q = new Query()

    expect(q.url).toBe('https://scanner.tradingview.com/america/scan')
    expect(q.query.markets).toEqual(['america'])
    expect(q.query.symbols).toEqual({})
    expect(q.query.options).toEqual({ lang: 'en' })
    expect(q.query.columns).toEqual([
      'name',
      'close',
      'type',
      'typespecs',
      'pricescale',
      'minmov',
      'fractional',
      'minmove2',
      'currency',
      'change',
      'volume',
      'relative_volume_10d_calc',
      'market_cap_basic',
      'fundamental_currency_code',
      'price_earnings_ttm',
      'earnings_per_share_diluted_ttm',
      'earnings_per_share_diluted_yoy_growth_ttm',
      'dividends_yield_current',
      'sector.tr',
      'market',
      'sector',
      'AnalystRating',
      'AnalystRating.tr',
    ])
    expect(q.query.filter).toEqual([
      { left: 'is_primary', operation: 'equal', right: true },
    ])
    expect(q.query.filter2?.operator).toBe('and')
    expect(q.query.filter2?.operands).toHaveLength(2)
    expect(q.query.sort).toEqual({ sortBy: 'market_cap_basic', sortOrder: 'desc' })
    expect(q.query.range).toEqual(DEFAULT_RANGE)
    expect(q.query.ignore_unknown_fields).toBe(false)
  })

  it('serializes Column operations, where, where2, select, order, range, and custom properties', () => {
    const q = new Query()
      .select('name', col('close'), new Column('volume'))
      .where(
        col('close').gte(col('VWAP')),
        col('type').isin(['stock', 'fund']),
      )
      .where2(Or(
        And(col('type').eq('stock'), col('typespecs').has(['common'])),
        col('type').eq('fund'),
      ))
      .orderBy(col('volume'), false, true)
      .offset(5)
      .limit(15)
      .setProperty('ignore_unknown_fields', true)

    expect(q.query.columns).toEqual(['name', 'close', 'volume'])
    expect(q.query.filter).toEqual([
      { left: 'close', operation: 'egreater', right: 'VWAP' },
      { left: 'type', operation: 'in_range', right: ['stock', 'fund'] },
    ])
    expect(q.query.filter2).toEqual({
      operator: 'or',
      operands: [
        {
          operation: {
            operator: 'and',
            operands: [
              { expression: { left: 'type', operation: 'equal', right: 'stock' } },
              { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
            ],
          },
        },
        { expression: { left: 'type', operation: 'equal', right: 'fund' } },
      ],
    })
    expect(q.query.sort).toEqual({
      sortBy: 'volume',
      sortOrder: 'desc',
      nullsFirst: true,
    })
    expect(q.query.range).toEqual([5, 15])
    expect(q.query.ignore_unknown_fields).toBe(true)
  })

  it('mirrors market, ticker, and index URL/payload mutations', () => {
    const italy = new Query().setMarkets('italy')
    expect(italy.url).toBe('https://scanner.tradingview.com/italy/scan')
    expect(italy.query.markets).toEqual(['italy'])

    const multiMarket = new Query().setMarkets('america', 'israel', 'hongkong')
    expect(multiMarket.url).toBe('https://scanner.tradingview.com/global/scan')
    expect(multiMarket.query.markets).toEqual(['america', 'israel', 'hongkong'])

    const tickers = new Query().setTickers('NASDAQ:TSLA', 'NYSE:GME')
    expect(tickers.url).toBe('https://scanner.tradingview.com/global/scan')
    expect(tickers.query.markets).toEqual([])
    expect(tickers.query.symbols?.tickers).toEqual(['NASDAQ:TSLA', 'NYSE:GME'])

    const index = new Query().setIndex('SYML:SP;SPX')
    expect(index.url).toBe('https://scanner.tradingview.com/global/scan')
    expect(index.query.markets).toEqual([])
    expect(index.query.preset).toBe('index_components_market_pages')
    expect(index.query.symbols?.symbolset).toEqual(['SYML:SP;SPX'])
  })
})

describe('TradingView preset factory parity', () => {
  it('creates stocks and asset-class presets with Python-equivalent URLs and sort keys', () => {
    expect(stocks().url).toBe('https://scanner.tradingview.com/america/scan')
    expect(stocks('italy').query.markets).toEqual(['italy'])

    expect(coin().query.sort).toEqual({ sortBy: 'crypto_total_rank', sortOrder: 'asc' })
    expect(coin().query.markets).toEqual(['coin'])

    expect(crypto().query.sort).toEqual({ sortBy: '24h_vol|5', sortOrder: 'desc' })
    expect(crypto().query.filter2).toEqual({
      operator: 'and',
      operands: [
        { expression: { left: 'centralization', operation: 'equal', right: 'cex' } },
      ],
    })

    expect(cryptoDex().query.sort).toEqual({ sortBy: 'dex_txs_count_24h', sortOrder: 'desc' })
    expect(forex().query.sort).toEqual({ sortBy: 'Value.Traded', sortOrder: 'desc' })
    expect(futures().query.markets).toEqual(['futures'])
    expect(bond().query.sort).toEqual({ sortBy: 'bond_snp_rating_lt', sortOrder: 'desc' })
    expect(cfd().query.columns).toEqual(['name', 'close', 'volume', 'currency'])
  })

  it('creates options scan2 payloads for the requested underlying', () => {
    const q = options('CME_MINI:ESM2026')

    expect(q.url).toBe(OPTIONS_SCAN2_URL)
    expect(q.query.index_filters).toEqual([
      { name: 'underlying_symbol', values: ['CME_MINI:ESM2026'] },
    ])
    expect(q.query.filter2).toEqual({
      operator: 'and',
      operands: [{ expression: { left: 'type', operation: 'equal', right: 'option' } }],
    })
    expect(q.query.columns).toContain('ask_iv')
  })
})

describe('TradingView scanner HTTP and normalization', () => {
  it('posts the scanner payload and normalizes scan rows', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = mockFetch({
      totalCount: 2,
      data: [
        { s: 'NASDAQ:AAPL', d: [190.1, 1000] },
        { s: 'NASDAQ:MSFT', d: [420.2, 2000] },
      ],
    }, calls)

    const q = new Query().select('close', 'volume')
    const result = await q.getScannerData({ fetch })

    expect(calls[0]?.url).toBe('https://scanner.tradingview.com/america/scan')
    expect(calls[0]?.init.method).toBe('POST')
    expect(parseBody(calls[0]!.init)).toMatchObject({
      markets: ['america'],
      columns: ['close', 'volume'],
      range: [0, 50],
    })
    expect(result).toEqual({
      totalCount: 2,
      fields: ['close', 'volume'],
      rows: [
        { ticker: 'NASDAQ:AAPL', close: 190.1, volume: 1000 },
        { ticker: 'NASDAQ:MSFT', close: 420.2, volume: 2000 },
      ],
    })
  })

  it('normalizes options scan2 rows from fields and symbols', async () => {
    const fetch = mockFetch({
      totalCount: 1,
      fields: ['ask', 'bid', 'delta'],
      symbols: [{ s: 'OPRA:AAPL260821C200.0', f: [4.1, 4, 0.55] }],
      time: '2026-04-24T13:45:37Z',
    })

    await expect(options('NASDAQ:AAPL').getScannerData({ fetch })).resolves.toEqual({
      totalCount: 1,
      fields: ['ask', 'bid', 'delta'],
      rows: [
        { ticker: 'OPRA:AAPL260821C200.0', ask: 4.1, bid: 4, delta: 0.55 },
      ],
    })
  })

  it('sends optional TradingView sessionid credentials as a cookie', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = mockFetch({ totalCount: 0, data: [] }, calls)

    await new Query().getScannerDataRaw({
      fetch,
      credentials: { tradingview_sessionid: 'session-123' },
      headers: { cookie: 'theme=dark' },
    })

    expect(calls[0]?.init.headers).toMatchObject({
      cookie: 'theme=dark; sessionid=session-123',
    })
  })

  it('searches symbols through TradingView symbol search v3', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = mockFetch({
      symbols: [
        {
          prefix: 'NASDAQ',
          exchange: 'NASDAQ Global Select',
          symbol: 'AAPL',
          description: 'Apple Inc.',
          type: 'stock',
        },
      ],
    }, calls)

    const result = await searchSymbols('nasdaq:aapl', {
      type: 'stock',
      offset: 10,
      fetch,
      credentials: { tradingview_sessionid: 'session-123' },
    })

    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://symbol-search.tradingview.com/symbol_search/v3')
    expect(url.searchParams.get('exchange')).toBe('NASDAQ')
    expect(url.searchParams.get('text')).toBe('AAPL')
    expect(url.searchParams.get('search_type')).toBe('stock')
    expect(url.searchParams.get('start')).toBe('10')
    expect(calls[0]?.init.headers).toMatchObject({ cookie: 'sessionid=session-123' })
    expect(result).toEqual([{
      id: 'NASDAQ:AAPL',
      exchange: 'NASDAQ',
      fullExchange: 'NASDAQ Global Select',
      symbol: 'AAPL',
      description: 'Apple Inc.',
      type: 'stock',
    }])
  })

  it('gets TradingView technical analysis values by period', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = mockFetch({
      totalCount: 1,
      data: [{ s: 'NASDAQ:AAPL', d: [0.1, 0.2, 0.3, -0.5, 0, 0.5] }],
    }, calls)

    const result = await getTechnicalAnalysis({
      symbol: 'NASDAQ:AAPL',
      periods: ['1', '1D'],
    }, { fetch })

    expect(calls[0]?.url).toBe('https://scanner.tradingview.com/global/scan')
    expect(calls[0]?.init.method).toBe('POST')
    expect(parseBody(calls[0]!.init)).toEqual({
      symbols: { tickers: ['NASDAQ:AAPL'] },
      columns: [
        'Recommend.Other|1',
        'Recommend.All|1',
        'Recommend.MA|1',
        'Recommend.Other',
        'Recommend.All',
        'Recommend.MA',
      ],
    })
    expect(result).toEqual({
      symbol: 'NASDAQ:AAPL',
      periods: {
        '1': { Other: 0.2, All: 0.4, MA: 0.6 },
        '1D': { Other: -1, All: 0, MA: 1 },
      },
    })
  })
})

describe('TradingView provider registry', () => {
  it('registers the provider without making the optional session cookie mandatory', () => {
    const provider = createRegistry().providers.get('tradingview')

    expect(provider?.name).toBe('tradingview')
    expect(provider?.credentials).toEqual([])
    expect(provider?.fetcherDict).toEqual({})
  })
})
