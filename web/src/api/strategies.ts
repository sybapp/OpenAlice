import { fetchJson, fetchJsonOrThrow, fetchOkOrThrow, headers } from './client'
import type {
  CronSchedule,
  TraderJob,
  TraderReviewJob,
  TraderReviewResult,
  TraderStrategyDraft,
  TraderStrategyDetail,
  TraderStrategyGenerateResult,
  TraderStrategySummary,
  TraderStrategyTemplate,
  TraderStrategyTemplateId,
  TraderStrategyUpdateResult,
} from './types'

export const strategiesApi = {
  async listTemplates(): Promise<{ templates: TraderStrategyTemplate[] }> {
    return fetchJson('/api/strategies/templates')
  },

  async listStrategies(): Promise<{ strategies: TraderStrategySummary[] }> {
    return fetchJson('/api/strategies/strategies')
  },

  async getStrategy(id: string): Promise<TraderStrategyDetail> {
    return fetchJson(`/api/strategies/strategies/${id}`)
  },

  async createStrategy(strategy: TraderStrategyDraft): Promise<TraderStrategyDraft> {
    return fetchJsonOrThrow('/api/strategies/strategies', {
      method: 'POST',
      headers,
      body: JSON.stringify(strategy),
    }, 'Create failed')
  },

  async updateStrategy(id: string, strategy: TraderStrategyDraft): Promise<TraderStrategyUpdateResult> {
    return fetchJsonOrThrow(`/api/strategies/strategies/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(strategy),
    }, 'Update failed')
  },

  async generateStrategy(params: {
    templateId: TraderStrategyTemplateId
    request: string
  }): Promise<TraderStrategyGenerateResult> {
    return fetchJsonOrThrow('/api/strategies/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    }, 'Generate failed')
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
