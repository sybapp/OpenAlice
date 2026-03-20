import { fetchJson } from './client'
import type { TraderWorkflowRunDetail, TraderWorkflowRunStatus, TraderWorkflowRunSummary } from './types'

export interface TraderWorkflowQueryResult {
  entries: TraderWorkflowRunSummary[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export const workflowsApi = {
  async listTraderRuns(opts: { page?: number; pageSize?: number; status?: TraderWorkflowRunStatus; strategyId?: string } = {}): Promise<TraderWorkflowQueryResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.status) params.set('status', opts.status)
    if (opts.strategyId) params.set('strategyId', opts.strategyId)
    const qs = params.toString()
    return fetchJson(`/api/workflows/trader-runs${qs ? `?${qs}` : ''}`)
  },

  async getTraderRun(runId: string): Promise<TraderWorkflowRunDetail> {
    return fetchJson(`/api/workflows/trader-runs/${encodeURIComponent(runId)}`)
  },
}
