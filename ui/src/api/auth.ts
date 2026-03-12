import { fetchJson, headers } from './client'

export interface AuthCheckResponse {
  authRequired: boolean
}

export interface AuthVerifyResponse {
  valid: boolean
}

export const authApi = {
  async check(): Promise<AuthCheckResponse> {
    return fetchJson('/api/auth/check')
  },

  async verify(token: string): Promise<AuthVerifyResponse> {
    return fetchJson('/api/auth/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token }),
    })
  },
}
