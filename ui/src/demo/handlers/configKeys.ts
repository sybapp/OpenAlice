import { http, HttpResponse } from 'msw'
import type { AppConfig } from '../../api/types'

const demoConfig: AppConfig = {
  aiProvider: { apiKeys: {}, profiles: {}, activeProfile: '' },
  marketData: {
    enabled: true,
    apiUrl: 'http://localhost:6900',
    backend: 'typebb-sdk',
    providers: {
      equity: 'yfinance',
      crypto: 'yfinance',
      currency: 'yfinance',
      commodity: 'yfinance',
      scanner: 'tradingview',
    },
    providerKeys: {},
  },
  engine: {},
  agent: { evolutionMode: false, claudeCode: {} },
  compaction: { maxContextTokens: 0, maxOutputTokens: 0 },
  heartbeat: { enabled: false, every: '1h', prompt: '', activeHours: null },
  snapshot: { enabled: false, every: '1h' },
  mcp: { port: 47332 },
  connectors: {
    web: { port: 47331 },
    mcpAsk: { enabled: false },
    telegram: { enabled: false, chatIds: [] },
  },
}

export const configKeysHandlers = [
  http.get('/api/config/api-keys/status', () => HttpResponse.json({})),
  http.put('/api/config/apiKeys', () => new HttpResponse(null, { status: 204 })),

  http.get('/api/config', () => HttpResponse.json(demoConfig)),

  http.get('/api/config/profiles', () =>
    HttpResponse.json({ profiles: {}, credentials: {}, activeProfile: '' }),
  ),
  http.post('/api/config/profiles', () =>
    HttpResponse.json({ slug: 'demo', profile: { backend: 'mock', model: 'demo' } }, { status: 201 }),
  ),
  http.put('/api/config/profiles/:slug', () =>
    HttpResponse.json({ slug: 'demo', profile: { backend: 'mock', model: 'demo' } }),
  ),
  http.delete('/api/config/profiles/:slug', () => HttpResponse.json({ success: true })),
  http.post('/api/config/profiles/test', () => HttpResponse.json({ ok: true })),
  http.put('/api/config/active-profile', () => HttpResponse.json({ ok: true })),

  http.get('/api/config/presets', () => HttpResponse.json({ presets: [] })),
  http.get('/api/config/sdk-adapters', () => HttpResponse.json({ adapters: [] })),
]
