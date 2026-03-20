import { fetchJson, fetchJsonOrThrow, headers } from './client'

export interface RegistryConnector {
  channel: string
  to: string
  capabilities: { push: boolean; media: boolean }
}

export interface RegistryResponse {
  connectors: RegistryConnector[]
  lastInteraction: { channel: string; to: string; ts: number } | null
}

export interface SendRequest {
  channel?: string
  kind?: 'message' | 'notification'
  text: string
  source?: 'heartbeat' | 'cron' | 'manual'
}

export interface SendResponse {
  channel: string
  to: string
  delivered: boolean
}

export interface SessionInfo {
  id: string
  sizeBytes: number
}

export type RuntimeDataTarget = 'chat' | 'events' | 'brain'

export interface RuntimeDataClearResult {
  target: RuntimeDataTarget
  removedEntries: number
  message: string
}

export const devApi = {
  async registry(): Promise<RegistryResponse> {
    return fetchJson('/api/dev/registry')
  },

  async send(req: SendRequest): Promise<SendResponse> {
    return fetchJsonOrThrow('/api/dev/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    }, 'Unknown error')
  },

  async sessions(): Promise<SessionInfo[]> {
    const data = await fetchJson<{ sessions: SessionInfo[] }>('/api/dev/sessions')
    return data.sessions
  },

  async clearRuntimeData(target: RuntimeDataTarget): Promise<RuntimeDataClearResult> {
    return fetchJsonOrThrow('/api/dev/runtime/clear', {
      method: 'POST',
      headers,
      body: JSON.stringify({ target }),
    }, 'Failed to clear runtime data')
  },
}
