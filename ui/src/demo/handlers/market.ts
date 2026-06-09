import { http, HttpResponse } from 'msw'
import {
  demoMarketAAPL,
  demoMarketSearchAAPL,
  demoMarketEmpty,
  demoSectorRotation,
} from '../fixtures/market'
import type { MarketDataEnvelope } from '../../api/market'

const AAPL = 'AAPL'

function symbolFromUrl(url: string): string {
  return (new URL(url).searchParams.get('symbol') ?? '').toUpperCase()
}

function serviceEnvelope(endpoint: string, payload: { results?: unknown[] | null; provider?: string; error?: string }): MarketDataEnvelope {
  const rows = (payload.results ?? []) as Array<Record<string, unknown>>
  return {
    provider: payload.provider ?? 'demo',
    endpoint,
    totalCount: rows.length,
    fields: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows,
    warnings: [],
    ...(payload.error ? { error: payload.error } : {}),
  }
}

function queryPayload(endpoint: string, symbol: string): MarketDataEnvelope {
  if (symbol !== AAPL) return serviceEnvelope(endpoint, demoMarketEmpty)
  switch (endpoint) {
    case '/equity/price/historical': return serviceEnvelope(endpoint, demoMarketAAPL.historical)
    case '/equity/profile': return serviceEnvelope(endpoint, demoMarketAAPL.profile)
    case '/equity/price/quote': return serviceEnvelope(endpoint, demoMarketAAPL.quote)
    case '/equity/fundamental/metrics': return serviceEnvelope(endpoint, demoMarketAAPL.metrics)
    case '/equity/fundamental/ratios': return serviceEnvelope(endpoint, demoMarketAAPL.ratios)
    case '/equity/fundamental/balance': return serviceEnvelope(endpoint, demoMarketAAPL.balance)
    case '/equity/fundamental/income': return serviceEnvelope(endpoint, demoMarketAAPL.income)
    case '/equity/fundamental/cash': return serviceEnvelope(endpoint, demoMarketAAPL.cash)
    default: return serviceEnvelope(endpoint, demoMarketEmpty)
  }
}

export const marketHandlers = [
  // Search — AAPL / Apple matches the snapshot; anything else returns empty.
  http.get('/api/market/search', ({ request }) => {
    const q = (new URL(request.url).searchParams.get('query') ?? '').toLowerCase()
    if (q === 'aapl' || q === 'apple' || (q.length > 0 && 'apple inc.'.startsWith(q))) {
      return HttpResponse.json(demoMarketSearchAAPL)
    }
    return HttpResponse.json({ results: [], count: 0 })
  }),

  // Sector rotation — static snapshot fixture.
  http.get('/api/market/sector-rotation', () => HttpResponse.json(demoSectorRotation)),

  http.get('/api/market-data/query', ({ request }) => {
    const url = new URL(request.url)
    const endpoint = url.searchParams.get('endpoint') ?? ''
    return HttpResponse.json(queryPayload(endpoint, symbolFromUrl(request.url)))
  }),

  http.post('/api/market-data/test-provider', () => HttpResponse.json({ ok: true })),
]
