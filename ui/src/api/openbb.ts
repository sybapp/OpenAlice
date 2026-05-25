import { fetchJson, headers } from './client'

export interface MarketDataCacheStatus {
  interval: string
  exists: boolean
  healthy: boolean
  provider: string
  asset: string
  symbol: string
  bars: number
  from: string
  to: string
  updatedAt: string | null
  error?: string
}

export interface MarketDataWatchItem {
  asset: string
  symbol: string
  intervals: string[]
  provider: string
  lookbackBars: number
  cache: MarketDataCacheStatus[]
}

export interface MarketDataWatchResponse {
  enabled: boolean
  every: string
  count: number
  items: MarketDataWatchItem[]
}

export interface MarketDataAlertItem {
  asset: string
  symbol: string
  interval: string
  provider: string | null
  enabled: boolean
  mode: 'deterministic' | 'agent' | 'both'
  cooldownMinutes: number
  lookbackBars: number
  thresholds: Record<string, unknown> | null
  options: Record<string, unknown>
}

export interface MarketDataAlertsResponse {
  enabled: boolean
  every: string
  mode: 'deterministic' | 'agent' | 'both'
  cooldownMinutes: number
  lookbackBars: number
  count: number
  items: MarketDataAlertItem[]
}

export interface MarketDataAlertRun {
  runId: string
  startedAt: string
  finishedAt: string
  asset?: string
  symbol?: string
  interval?: string
  provider?: string
  mode?: string
  status: 'triggered' | 'skipped' | 'error'
  reason?: string
  latestClose?: number
  signals: Array<{
    id: string
    kind: string
    label: string
    message: string
    index: number
    time: string | number
    direction?: 'bullish' | 'bearish'
    price?: number
    volumeConfirmation?: 'confirmed' | 'weak' | 'unavailable'
    score?: number
    confluenceScore?: number
  }>
  notified: boolean
  taskRequested: boolean
  error?: string
  summary: string
  feedback?: { rating: string; note?: string; updatedAt: string }
}

export interface MarketDataAlertRunsResponse {
  count: number
  entries: MarketDataAlertRun[]
}

export const marketDataApi = {
  async testProvider(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch('/api/market-data/test-provider', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider, key }),
    })
    return res.json()
  },
  watch(): Promise<MarketDataWatchResponse> {
    return fetchJson('/api/market-data/watch')
  },
  alerts(): Promise<MarketDataAlertsResponse> {
    return fetchJson('/api/market-data/alerts')
  },
  upsertAlert(body: {
    asset: string
    symbol: string
    interval?: string
    provider?: string | null
    enabled?: boolean
    mode?: 'deterministic' | 'agent' | 'both'
    lookbackBars?: number
    cooldownMinutes?: number
    maxSignalAgeBars?: number
    minVolumeScore?: number
    options?: Record<string, unknown>
    enableAlerts?: boolean
    ensureWatch?: boolean
  }): Promise<{ action: 'added' | 'updated'; enabled: boolean; every: string; item: MarketDataAlertItem; count: number; watchEnsured: boolean }> {
    return fetchJson('/api/market-data/alerts', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  },
  runWatch(): Promise<unknown> {
    return fetchJson('/api/market-data/watch/run', { method: 'POST', headers, body: '{}' })
  },
  runAlerts(): Promise<unknown> {
    return fetchJson('/api/market-data/alerts/run', { method: 'POST', headers, body: '{}' })
  },
  alertRuns(params: { limit?: number; asset?: string; symbol?: string; interval?: string; status?: string } = {}): Promise<MarketDataAlertRunsResponse> {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') qs.set(key, String(value))
    }
    return fetchJson(`/api/market-data/alerts/runs${qs.size ? `?${qs}` : ''}`)
  },
  recordAlertFeedback(runId: string, rating: string, note?: string): Promise<{ ok: boolean; error?: string }> {
    return fetchJson(`/api/market-data/alerts/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rating, note }),
    })
  },
}
