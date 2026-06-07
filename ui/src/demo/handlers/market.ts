import { http, HttpResponse } from 'msw'
import {
  demoMarketAAPL,
  demoMarketSearchAAPL,
  demoMarketEmpty,
  demoSectorRotation,
} from '../fixtures/market'
import type { BarSourceCandidate, BarMeta, MarketDataEnvelope } from '../../api/market'

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

  // ---- federated bars (multi-source K-lines) ----
  // AAPL has two demo sources so the source picker is exercised.
  http.get('/api/bars/search', ({ request }) => {
    const q = (new URL(request.url).searchParams.get('query') ?? '').toUpperCase()
    if (!q.includes('AAPL') && !q.includes('APPLE')) return HttpResponse.json({ candidates: [], count: 0 })
    const candidates: BarSourceCandidate[] = [
      { barId: 'yfinance|AAPL', source: 'vendor', sourceId: 'yfinance', symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', label: 'AAPL', barCapability: 'delayed' },
      { barId: 'alpaca-paper|AAPL', source: 'uta', sourceId: 'alpaca-paper', symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', label: 'AAPL', barCapability: 'iex' },
    ]
    return HttpResponse.json({ candidates, count: candidates.length })
  }),
  http.get('/api/bars', ({ request }) => {
    const url = new URL(request.url)
    const barId = url.searchParams.get('barId')
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase()
    if (!(barId?.includes('AAPL') || symbol === AAPL)) {
      return HttpResponse.json({ results: null, meta: null, error: 'No demo data for this symbol.' })
    }
    const results = demoMarketAAPL.historical.results
    const sourceId = barId ? barId.split('|')[0] : 'yfinance'
    const meta: BarMeta = {
      symbol: 'AAPL', from: results[0]?.date ?? '', to: results[results.length - 1]?.date ?? '', bars: results.length,
      source: sourceId === 'alpaca-paper' ? 'uta' : 'vendor', sourceId, barId: barId ?? `${sourceId}|AAPL`,
      provider: sourceId, barCapability: sourceId === 'alpaca-paper' ? 'iex' : 'delayed',
    }
    return HttpResponse.json({ results, meta })
  }),

  http.get('/api/market-data/query', ({ request }) => {
    const url = new URL(request.url)
    const endpoint = url.searchParams.get('endpoint') ?? ''
    return HttpResponse.json(queryPayload(endpoint, symbolFromUrl(request.url)))
  }),

  http.post('/api/market-data/test-provider', () => HttpResponse.json({ ok: true })),
]
