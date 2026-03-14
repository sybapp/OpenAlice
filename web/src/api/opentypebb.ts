import { fetchJsonOrThrow, headers } from './client'

export const opentypebbApi = {
  async testProvider(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
    return fetchJsonOrThrow('/api/integrations/opentypebb/test-provider', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider, key }),
    }, 'OpenTypeBB request failed')
  },
}
