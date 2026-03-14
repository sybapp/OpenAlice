import { fetchJson, fetchJsonOrThrow, fetchOkOrThrow, headers } from './client'
import type { CronJob, CronSchedule } from './types'

export const cronApi = {
  async list(): Promise<{ jobs: CronJob[] }> {
    return fetchJson('/api/cron/jobs')
  },

  async add(params: { name: string; payload: string; schedule: CronSchedule; enabled?: boolean }): Promise<{ id: string }> {
    return fetchJsonOrThrow('/api/cron/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    }, 'Create failed')
  },

  async update(id: string, patch: Partial<{ name: string; payload: string; schedule: CronSchedule; enabled: boolean }>): Promise<void> {
    await fetchOkOrThrow(`/api/cron/jobs/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(patch),
    }, 'Update failed')
  },

  async remove(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/cron/jobs/${id}`, { method: 'DELETE' }, 'Delete failed')
  },

  async runNow(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/cron/jobs/${id}/run`, { method: 'POST' }, 'Run failed')
  },
}
