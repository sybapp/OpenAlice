import { fetchJson, fetchJsonOrThrow, fetchOkOrThrow, headers } from './client'
import type {
  CronSchedule,
  TraderJob,
  TraderReviewJob,
  TraderReviewResult,
  TraderStrategyDetail,
  TraderStrategySummary,
} from './types'

export const strategiesApi = {
  async listStrategies(): Promise<{ strategies: TraderStrategySummary[] }> {
    return fetchJson('/api/strategies/strategies')
  },

  async getStrategy(id: string): Promise<TraderStrategyDetail> {
    return fetchJson(`/api/strategies/strategies/${id}`)
  },

  async listJobs(): Promise<{ jobs: TraderJob[] }> {
    return fetchJson('/api/strategies/jobs')
  },

  async addJob(params: {
    name: string
    strategyId: string
    schedule: CronSchedule
    enabled?: boolean
  }): Promise<{ id: string }> {
    return fetchJsonOrThrow('/api/strategies/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    }, 'Create failed')
  },

  async updateJob(id: string, patch: Partial<{
    name: string
    strategyId: string
    schedule: CronSchedule
    enabled: boolean
  }>): Promise<void> {
    await fetchOkOrThrow(`/api/strategies/jobs/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    }, 'Update failed')
  },

  async removeJob(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/strategies/jobs/${id}`, { method: 'DELETE' }, 'Delete failed')
  },

  async runJob(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/strategies/jobs/${id}/run`, { method: 'POST' }, 'Run failed')
  },

  async runReview(strategyId?: string): Promise<TraderReviewResult> {
    return fetchJsonOrThrow('/api/strategies/review', {
      method: 'POST',
      headers,
      body: JSON.stringify(strategyId ? { strategyId } : {}),
    }, 'Review failed')
  },

  async listReviewJobs(): Promise<{ jobs: TraderReviewJob[] }> {
    return fetchJson('/api/strategies/review/jobs')
  },

  async addReviewJob(params: {
    name: string
    strategyId?: string
    schedule: CronSchedule
    enabled?: boolean
  }): Promise<{ id: string }> {
    return fetchJsonOrThrow('/api/strategies/review/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    }, 'Create failed')
  },

  async updateReviewJob(id: string, patch: Partial<{
    name: string
    strategyId?: string
    schedule: CronSchedule
    enabled: boolean
  }>): Promise<void> {
    await fetchOkOrThrow(`/api/strategies/review/jobs/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    }, 'Update failed')
  },

  async removeReviewJob(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/strategies/review/jobs/${id}`, { method: 'DELETE' }, 'Delete failed')
  },

  async runReviewJob(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/strategies/review/jobs/${id}/run`, { method: 'POST' }, 'Run failed')
  },
}
