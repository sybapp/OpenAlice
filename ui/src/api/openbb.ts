import { fetchJsonOrThrow, headers } from './client'

export const openbbApi = {
  async testProvider(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
    return fetchJsonOrThrow('/api/openbb/test-provider', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider, key }),
    }, 'OpenBB request failed')
  },
}
