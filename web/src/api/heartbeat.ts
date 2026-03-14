import { fetchJson, fetchJsonOrThrow, fetchOkOrThrow, headers } from './client'

export const heartbeatApi = {
  async status(): Promise<{ enabled: boolean }> {
    return fetchJson('/api/heartbeat/status')
  },

  async trigger(): Promise<void> {
    await fetchOkOrThrow('/api/heartbeat/trigger', { method: 'POST' }, 'Trigger failed')
  },

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return fetchJsonOrThrow('/api/heartbeat/enabled', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled }),
    }, 'Update failed')
  },

  async getPromptFile(): Promise<{ content: string; path: string }> {
    return fetchJson('/api/heartbeat/prompt-file')
  },

  async updatePromptFile(content: string): Promise<void> {
    await fetchOkOrThrow('/api/heartbeat/prompt-file', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ content }),
    }, 'Failed to save prompt file')
  },
}
