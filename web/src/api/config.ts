import { fetchJson, fetchJsonOrThrow, fetchOkOrThrow, headers } from './client'
import type { AppConfig, ConfigUpdateResponse } from './types'

function isWrappedConfigUpdateResponse<T>(payload: unknown): payload is ConfigUpdateResponse<T> {
  return typeof payload === 'object' && payload !== null && 'data' in payload
}

function normalizeConfigUpdateResponse<T>(payload: unknown): ConfigUpdateResponse<T> {
  if (isWrappedConfigUpdateResponse<T>(payload)) return payload
  return { data: payload as T }
}

export const configApi = {
  async load(): Promise<AppConfig> {
    return fetchJson('/api/config')
  },

  async setBackend(backend: string): Promise<void> {
    await fetchOkOrThrow('/api/config/ai-provider', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ backend }),
    }, 'Failed to switch backend')
  },

  async updateSection<T>(section: string, data: unknown): Promise<ConfigUpdateResponse<T>> {
    const payload = await fetchJsonOrThrow<unknown>(`/api/config/${section}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(data),
    }, 'Save failed')
    return normalizeConfigUpdateResponse<T>(payload)
  },
}
