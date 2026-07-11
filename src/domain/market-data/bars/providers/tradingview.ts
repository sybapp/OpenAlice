import type {
  AssetClass,
  BarProvider,
  BarSourceCandidate,
  GetBarsOpts,
  OhlcvBar,
} from '../types.js'
import {
  fetchTradingViewBars,
  type TradingViewBar,
} from './tradingview-websocket.js'

const INTERVALS: Record<string, string> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
  '1w': 'W',
}

const SEARCH_TYPES: Array<{ type: string; assetClass: AssetClass }> = [
  { type: 'stock', assetClass: 'equity' },
  { type: 'crypto', assetClass: 'crypto' },
  { type: 'forex', assetClass: 'currency' },
]

interface SearchResponse {
  symbols?: Array<Record<string, unknown>>
}

function intervalMinutes(interval: string): number {
  const match = interval.match(/^(\d+)([mhdw])$/)
  if (!match) return 1
  const value = Number(match[1])
  return value * ({ m: 1, h: 60, d: 1440, w: 10080 }[match[2]] ?? 1)
}

function rangeFor(opts: GetBarsOpts): number {
  if (opts.count !== undefined) return Math.min(opts.count, 10_000)
  if (!opts.start) return opts.interval === '1m' ? 5_000 : 1_000
  const start = new Date(`${opts.start}T00:00:00Z`).getTime()
  const end = opts.end ? new Date(`${opts.end}T23:59:59Z`).getTime() : Date.now()
  return Math.max(100, Math.min(Math.ceil((end - start) / 60_000 / intervalMinutes(opts.interval)) + 50, 10_000))
}

function fullSymbol(row: Record<string, unknown>): string {
  const symbol = String(row['symbol'] ?? '').toUpperCase()
  const prefix = typeof row['prefix'] === 'string' ? row['prefix'].toUpperCase() : ''
  const exchange = typeof row['exchange'] === 'string' ? row['exchange'].split(' ')[0].toUpperCase() : ''
  const source = prefix || exchange
  return source ? `${source}:${symbol}` : symbol
}

async function searchType(query: string, type: string): Promise<Array<Record<string, unknown>>> {
  const normalized = query.toUpperCase()
  const [exchange, text] = normalized.includes(':') ? normalized.split(':', 2) : ['', normalized]
  const url = new URL('https://symbol-search.tradingview.com/symbol_search/v3')
  url.searchParams.set('text', text)
  url.searchParams.set('search_type', type)
  if (exchange) url.searchParams.set('exchange', exchange)
  const response = await fetch(url, {
    headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' },
  })
  if (!response.ok) throw new Error(`TradingView search failed: HTTP ${response.status}`)
  return ((await response.json()) as SearchResponse).symbols ?? []
}

function mapBar(bar: TradingViewBar): OhlcvBar {
  return {
    date: new Date(bar.time * 1000).toISOString().slice(0, 19).replace('T', ' '),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    coverage: 'tradingview_global',
    volumeQuality: 'exchange_dependent',
  }
}

export function createTradingViewBarProvider(isEnabled?: () => Promise<boolean>): BarProvider {
  return {
    id: 'tradingview',
    capability: 'delayed',
    ...(isEnabled ? { isEnabled } : {}),
    async search(query, limit) {
      const settled = await Promise.allSettled(SEARCH_TYPES.map(async ({ type, assetClass }) => ({
        assetClass,
        rows: await searchType(query, type),
      })))
      const candidates: BarSourceCandidate[] = []
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue
        for (const row of result.value.rows) {
          const symbol = fullSymbol(row)
          if (!symbol) continue
          const name = typeof row['description'] === 'string' ? row['description'] : undefined
          candidates.push({
            barId: `tradingview|${symbol}`,
            source: 'vendor',
            sourceId: 'tradingview',
            symbol,
            ...(name ? { name } : {}),
            assetClass: result.value.assetClass,
            label: `${name ? `${symbol} · ${name}` : symbol} (tradingview) · delayed`,
            barCapability: 'delayed',
          })
        }
      }
      return candidates.slice(0, limit)
    },
    async getBars(symbol, _assetClass, opts) {
      const interval = INTERVALS[opts.interval]
      if (!interval) throw new Error(`TradingView does not support interval ${opts.interval}`)
      const bars = await fetchTradingViewBars({
        symbol,
        interval,
        range: rangeFor(opts),
        to: opts.end ? Math.floor(new Date(`${opts.end}T23:59:59Z`).getTime() / 1000) : null,
      })
      return bars
        .map(mapBar)
        .filter((bar) => !opts.start || bar.date.slice(0, 10) >= opts.start)
        .filter((bar) => !opts.end || bar.date.slice(0, 10) <= opts.end)
    },
  }
}
