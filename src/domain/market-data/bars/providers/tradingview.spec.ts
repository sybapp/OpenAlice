import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTradingViewBarProvider } from './tradingview.js'

afterEach(() => vi.unstubAllGlobals())

describe('TradingView BarProvider', () => {
  it('maps search results into canonical bar-source candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: URL) => ({
      ok: true,
      json: async () => ({
        symbols: [{ symbol: 'AAPL', prefix: 'NASDAQ', description: 'Apple Inc.' }],
      }),
    })))

    const candidates = await createTradingViewBarProvider().search('AAPL', 10)

    expect(candidates).toContainEqual(expect.objectContaining({
      barId: 'tradingview|NASDAQ:AAPL',
      sourceId: 'tradingview',
      symbol: 'NASDAQ:AAPL',
      barCapability: 'delayed',
    }))
  })

  it('declares the conservative exchange-dependent capability', () => {
    expect(createTradingViewBarProvider()).toMatchObject({ id: 'tradingview', capability: 'delayed' })
  })
})
