import { describe, expect, it, vi } from 'vitest'
import { createMarketDataRoutes } from './config.js'
import type { EngineContext } from '../../core/types.js'

function ctx() {
  const marketDataService = {
    query: vi.fn(async () => ({
      provider: 'fmp',
      endpoint: '/equity/profile',
      totalCount: 1,
      fields: ['symbol'],
      rows: [{ symbol: 'AAPL' }],
      warnings: [],
    })),
    scan: vi.fn(async () => ({
      provider: 'tradingview',
      endpoint: '/scan',
      totalCount: 1,
      fields: ['ticker'],
      rows: [{ ticker: 'NASDAQ:AAPL' }],
      warnings: [],
    })),
  }
  return {
    ctx: { marketDataService } as unknown as EngineContext,
    marketDataService,
  }
}

describe('createMarketDataRoutes market-data service integration', () => {
  it('GET /query forwards query-string params into MarketDataService.query', async () => {
    const t = ctx()
    const app = createMarketDataRoutes(t.ctx)

    const res = await app.request('/query?endpoint=/equity/profile&symbol=AAPL&provider=fmp&limit=3')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.rows).toEqual([{ symbol: 'AAPL' }])
    expect(t.marketDataService.query).toHaveBeenCalledWith({
      endpoint: '/equity/profile',
      provider: 'fmp',
      limit: 3,
      params: { symbol: 'AAPL' },
    })
  })

  it('POST /test-provider checks ordinary providers through MarketDataService.query', async () => {
    const t = ctx()
    const app = createMarketDataRoutes(t.ctx)

    const res = await app.request('/test-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'fmp', key: 'secret' }),
    })

    expect(await res.json()).toEqual({ ok: true })
    expect(t.marketDataService.query).toHaveBeenCalledWith({
      endpoint: '/equity/screener',
      provider: 'fmp',
      params: { limit: 1 },
      limit: 1,
      credentials: { fmp_api_key: 'secret' },
    })
  })

  it('POST /test-provider checks TradingView session IDs through MarketDataService.scan', async () => {
    const t = ctx()
    const app = createMarketDataRoutes(t.ctx)

    const res = await app.request('/test-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'tradingview_sessionid', key: 'session-123' }),
    })

    expect(await res.json()).toEqual({ ok: true })
    expect(t.marketDataService.scan).toHaveBeenCalledWith({
      limit: 1,
      credentials: { tradingview_sessionid: 'session-123' },
    })
  })
})
