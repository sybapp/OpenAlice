import { describe, expect, it, vi } from 'vitest'
import { createTradingViewBarAdapter, tradingViewAssetClasses } from './tradingview.js'
import type { TradingViewClient } from './tradingview-client.js'

function makeClient(over: Partial<TradingViewClient> = {}): TradingViewClient {
  return {
    search: vi.fn(async (_query, type) => [{
      symbol: type === 'crypto' ? 'BTCUSDT' : type === 'forex' ? 'EURUSD' : 'AAPL',
      prefix: type === 'crypto' ? 'BINANCE' : type === 'forex' ? 'FX' : 'NASDAQ',
      description: type === 'crypto' ? 'Bitcoin / Tether' : type === 'forex' ? 'Euro / U.S. Dollar' : 'Apple Inc.',
      exchange: type === 'crypto' ? 'Binance' : type === 'forex' ? 'FX' : 'NASDAQ',
    }]),
    getBars: vi.fn(async () => [
      { time: 1_717_203_600, open: 194, high: 196, low: 193, close: 195, volume: 10 },
      { time: 1_717_200_000, open: 190, high: 195, low: 189, close: 194, volume: 123.45 },
    ]),
    ...over,
  }
}

describe('TradingView native bar adapter', () => {
  it('searches enabled asset classes and returns source-stable candidates', async () => {
    const client = makeClient()
    const adapter = createTradingViewBarAdapter({
      client,
      enabledAssetClasses: async () => ['equity', 'crypto', 'currency'],
    })

    const candidates = await adapter.search('apple', { limit: 10 })

    expect(client.search).toHaveBeenCalledTimes(3)
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        barId: 'tradingview|NASDAQ:AAPL',
        sourceId: 'tradingview',
        symbol: 'NASDAQ:AAPL',
        assetClass: 'equity',
        barCapability: 'realtime',
      }),
      expect.objectContaining({ barId: 'tradingview|BINANCE:BTCUSDT', assetClass: 'crypto' }),
      expect.objectContaining({ barId: 'tradingview|FX:EURUSD', assetClass: 'currency' }),
    ]))
  })

  it('normalizes and filters bars through the adapter interface', async () => {
    const client = makeClient()
    const adapter = createTradingViewBarAdapter({ client, enabledAssetClasses: async () => [] })

    const bars = await adapter.getBars('NASDAQ:AAPL', {
      interval: '1h',
      start: '2024-06-01',
      end: '2024-06-01',
    })

    expect(client.getBars).toHaveBeenCalledWith({
      symbol: 'NASDAQ:AAPL',
      interval: '60',
      range: 100,
      to: 1_717_286_399,
    })
    expect(bars).toEqual([
      { date: '2024-06-01 00:00:00', open: 190, high: 195, low: 189, close: 194, volume: 123.45 },
      { date: '2024-06-01 01:00:00', open: 194, high: 196, low: 193, close: 195, volume: 10 },
    ])
  })

  it('resolves a bare symbol to TradingView’s exchange-qualified symbol', async () => {
    const client = makeClient()
    const adapter = createTradingViewBarAdapter({ client, enabledAssetClasses: async () => [] })

    await adapter.getBars('AAPL', { interval: '1d', count: 1 }, { assetClass: 'equity' })

    expect(client.search).toHaveBeenCalledWith('AAPL', 'stock')
    expect(client.getBars).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'NASDAQ:AAPL',
    }))
  })

  it('tries asset classes serially when a bare symbol has no context', async () => {
    const client = makeClient({
      search: vi.fn(async (_query, type) => type === 'crypto'
        ? [{ symbol: 'BTCUSDT', prefix: 'BINANCE', exchange: 'Binance' }]
        : []),
    })
    const adapter = createTradingViewBarAdapter({ client, enabledAssetClasses: async () => [] })

    await adapter.getBars('BTCUSDT', { interval: '1d', count: 1 })

    expect(client.search).toHaveBeenNthCalledWith(1, 'BTCUSDT', 'stock')
    expect(client.search).toHaveBeenNthCalledWith(2, 'BTCUSDT', 'crypto')
    expect(client.getBars).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BINANCE:BTCUSDT',
    }))
  })

  it('uses date-only values for daily bars and rejects unsupported intervals', async () => {
    const client = makeClient({
      getBars: vi.fn(async () => [
        { time: 1_717_200_000, open: 190, high: 195, low: 189, close: 194, volume: null },
      ]),
    })
    const adapter = createTradingViewBarAdapter({ client, enabledAssetClasses: async () => [] })

    await expect(adapter.getBars('NASDAQ:AAPL', { interval: '2h' }))
      .rejects.toThrow('Unsupported TradingView bar interval "2h"')
    await expect(adapter.getBars('NASDAQ:AAPL', { interval: '1d', count: 1 }))
      .resolves.toEqual([
        { date: '2024-06-01', open: 190, high: 195, low: 189, close: 194, volume: null },
      ])
  })

  it('rejects malformed and impossible date bounds before calling TradingView', async () => {
    const client = makeClient()
    const adapter = createTradingViewBarAdapter({ client, enabledAssetClasses: async () => [] })

    await expect(adapter.getBars('NASDAQ:AAPL', { interval: '1d', start: '2024-02-30' }))
      .rejects.toThrow('Invalid TradingView start date "2024-02-30"; expected YYYY-MM-DD')
    await expect(adapter.getBars('NASDAQ:AAPL', { interval: '1d', end: 'not-a-date' }))
      .rejects.toThrow('Invalid TradingView end date "not-a-date"; expected YYYY-MM-DD')
    await expect(adapter.getBars('NASDAQ:AAPL', {
      interval: '1d',
      start: '2024-06-02',
      end: '2024-06-01',
    })).rejects.toThrow('TradingView start date must not be after end date')
    expect(client.getBars).not.toHaveBeenCalled()
  })
})

describe('tradingViewAssetClasses', () => {
  it('lights up every searchable class when enabled through extraVendors', () => {
    // The Settings toggle and setMarketVendor only write extraVendors, which
    // carries no asset class — equity-only would hide BINANCE:/FX: addressing.
    expect(tradingViewAssetClasses({
      providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance' },
      extraVendors: ['tradingview'],
    })).toEqual(['equity', 'crypto', 'currency'])
  })

  it('honours per-asset provider opt-in when it is not an extra vendor', () => {
    expect(tradingViewAssetClasses({
      providers: { equity: 'yfinance', crypto: 'tradingview', currency: 'yfinance' },
      extraVendors: [],
    })).toEqual(['crypto'])
  })

  it('is empty when TradingView is off everywhere', () => {
    expect(tradingViewAssetClasses({
      providers: { equity: 'yfinance' },
      extraVendors: ['eastmoney'],
    })).toEqual([])
  })
})
