import { fetchJson, fetchOkOrThrow, headers } from './client'

export const apiKeysApi = {
  async status(): Promise<Record<string, boolean>> {
    return fetchJson('/api/config/api-keys/status')
  },

  async save(keys: Record<string, string>): Promise<void> {
    await fetchOkOrThrow('/api/config/apiKeys', {
      method: 'PUT',
      headers,
      body: JSON.stringify(keys),
    }, 'Save failed')
  },
}
