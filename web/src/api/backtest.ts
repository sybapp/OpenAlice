import { fetchJson, headers } from './client'
import type {
  BacktestBarsQuery,
  BacktestFetchBarsResponse,
  BacktestGitState,
  BacktestRunManifest,
  BacktestRunRecord,
  BacktestRunSummary,
  BacktestEquityPoint,
  BacktestEventEntry,
  BacktestStartRunRequest,
  SessionEntry,
} from './types'

export const backtestApi = {
  async listRuns(): Promise<{ runs: BacktestRunManifest[] }> {
    return fetchJson('/api/backtest/runs')
  },

  async fetchBars(query: BacktestBarsQuery): Promise<BacktestFetchBarsResponse> {
    const params = new URLSearchParams({
      assetType: query.assetType,
      symbol: query.symbol,
      startDate: query.startDate,
      endDate: query.endDate,
    })
    if (query.interval) params.set('interval', query.interval)
    return fetchJson(`/api/backtest/bars?${params.toString()}`)
  },

  async startRun(body: BacktestStartRunRequest): Promise<{ runId: string }> {
    return fetchJson('/api/backtest/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  },

  async getRun(runId: string): Promise<BacktestRunRecord> {
    return fetchJson(`/api/backtest/runs/${runId}`)
  },

  async getSummary(runId: string): Promise<BacktestRunSummary> {
    return fetchJson(`/api/backtest/runs/${runId}/summary`)
  },

  async getEquityCurve(runId: string, limit?: number): Promise<{ points: BacktestEquityPoint[] }> {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    return fetchJson(`/api/backtest/runs/${runId}/equity${params.size > 0 ? `?${params.toString()}` : ''}`)
  },

  async getEvents(runId: string, opts: { afterSeq?: number; limit?: number; type?: string } = {}): Promise<{ entries: BacktestEventEntry[] }> {
    const params = new URLSearchParams()
    if (opts.afterSeq) params.set('afterSeq', String(opts.afterSeq))
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.type) params.set('type', opts.type)
    return fetchJson(`/api/backtest/runs/${runId}/events${params.size > 0 ? `?${params.toString()}` : ''}`)
  },

  async getGitState(runId: string): Promise<BacktestGitState> {
    return fetchJson(`/api/backtest/runs/${runId}/git`)
  },

  async getSessionEntries(runId: string): Promise<{ entries: SessionEntry[] }> {
    return fetchJson(`/api/backtest/runs/${runId}/session`)
  },
}
