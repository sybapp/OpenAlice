import { fetchJson, fetchJsonOrThrow, headers, withAuthQuery } from './client'
import type { ChatResponse, ChatHistoryItem } from './types'

export const chatApi = {
  async send(message: string): Promise<ChatResponse> {
    return fetchJsonOrThrow('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
    }, 'Send failed')
  },

  async history(limit = 100): Promise<{ messages: ChatHistoryItem[] }> {
    return fetchJson(`/api/chat/history?limit=${limit}`)
  },

  connectSSE(onMessage: (data: { type: string; kind?: string; text: string; media?: Array<{ type: string; url: string }> }) => void): EventSource {
    const es = new EventSource(withAuthQuery('/api/chat/events'))
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        onMessage(data)
      } catch { /* ignore */ }
    }
    return es
  },
}
