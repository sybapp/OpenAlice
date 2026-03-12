import { Hono } from 'hono'
import {
  loadConfig,
  writeConfigSection,
  readAIProviderConfig,
  readOpenbbConfig,
  validSections,
  type ConfigSection,
  type Config,
} from '../../../core/config.js'
import { readAIConfig, writeAIConfig, type AIBackend } from '../../../core/ai-config.js'
import {
  hasOwn,
  isRecord,
  mergeSecretField,
  mergeSecretRecord,
  toSecretPresenceMap,
  withSecretPresence,
} from './secret-fields.js'

interface ConfigRouteOpts {
  onConnectorsChange?: () => Promise<void>
}

function resolveString(input: Record<string, unknown>, key: string, current: string): string {
  return typeof input[key] === 'string' ? input[key] : current
}

function resolveBoolean(input: Record<string, unknown>, key: string, current: boolean): boolean {
  return typeof input[key] === 'boolean' ? input[key] : current
}

function resolveNumber(input: Record<string, unknown>, key: string, current: number): number {
  return typeof input[key] === 'number' ? input[key] : current
}

function resolveOptionalString(input: Record<string, unknown>, key: string, current: string | undefined): string | undefined {
  return typeof input[key] === 'string' ? (input[key] || undefined) : current
}

function resolveOptionalStringWithPresence(input: Record<string, unknown>, key: string, current: string | undefined): string | undefined {
  if (!hasOwn(input, key)) return current
  return typeof input[key] === 'string' && input[key] ? input[key] : undefined
}

function resolveNumberArray(input: Record<string, unknown>, key: string, current: number[]): number[] {
  if (!Array.isArray(input[key])) return current
  return input[key].filter((value): value is number => typeof value === 'number')
}

function toClientAiProviderConfig(aiProvider: Config['aiProvider']) {
  return {
    ...aiProvider,
    apiKeys: toSecretPresenceMap(aiProvider.apiKeys),
  }
}

function toClientOpenbbConfig(openbb: Config['openbb']) {
  return {
    ...openbb,
    providerKeys: toSecretPresenceMap(openbb.providerKeys),
  }
}

function toClientConnectorsConfig(connectors: Config['connectors']) {
  return {
    ...connectors,
    web: withSecretPresence({
      port: connectors.web.port,
      authToken: connectors.web.authToken,
    }, { authToken: 'hasAuthToken' }),
    mcpAsk: withSecretPresence({
      ...connectors.mcpAsk,
      authToken: connectors.mcpAsk.authToken,
    }, { authToken: 'hasAuthToken' }),
    telegram: withSecretPresence({
      enabled: connectors.telegram.enabled,
      botToken: connectors.telegram.botToken,
      botUsername: connectors.telegram.botUsername,
      chatIds: connectors.telegram.chatIds,
    }, { botToken: 'hasBotToken' }),
  }
}

function toClientConfig(config: Config) {
  return {
    ...config,
    aiProvider: toClientAiProviderConfig(config.aiProvider),
    openbb: toClientOpenbbConfig(config.openbb),
    connectors: toClientConnectorsConfig(config.connectors),
  }
}

async function writeAiProviderSection(body: unknown): Promise<Config['aiProvider']> {
  const current = (await loadConfig()).aiProvider
  const input = isRecord(body) ? body : {}
  const mergedApiKeys = mergeSecretRecord(current.apiKeys, input.apiKeys)
  const baseUrl = resolveOptionalStringWithPresence(input, 'baseUrl', current.baseUrl)

  const merged: Config['aiProvider'] = {
    backend: resolveString(input, 'backend', current.backend) as Config['aiProvider']['backend'],
    provider: resolveString(input, 'provider', current.provider),
    model: resolveString(input, 'model', current.model),
    ...(baseUrl ? { baseUrl } : {}),
    apiKeys: mergedApiKeys,
  }

  return writeConfigSection('aiProvider', merged) as Promise<Config['aiProvider']>
}

async function writeOpenbbSection(body: unknown): Promise<Config['openbb']> {
  const current = (await loadConfig()).openbb
  const input = isRecord(body) ? body : {}
  const providersInput = isRecord(input.providers) ? input.providers : {}
  const mergedProviderKeys = mergeSecretRecord(current.providerKeys, input.providerKeys)

  const merged: Config['openbb'] = {
    enabled: resolveBoolean(input, 'enabled', current.enabled),
    apiUrl: resolveString(input, 'apiUrl', current.apiUrl),
    providers: {
      equity: resolveString(providersInput, 'equity', current.providers.equity),
      crypto: resolveString(providersInput, 'crypto', current.providers.crypto),
      currency: resolveString(providersInput, 'currency', current.providers.currency),
      newsCompany: resolveString(providersInput, 'newsCompany', current.providers.newsCompany),
      newsWorld: resolveString(providersInput, 'newsWorld', current.providers.newsWorld),
    },
    providerKeys: mergedProviderKeys,
  }

  return writeConfigSection('openbb', merged) as Promise<Config['openbb']>
}

async function writeConnectorsSection(body: unknown): Promise<Config['connectors']> {
  const current = (await loadConfig()).connectors
  const input = isRecord(body) ? body : {}
  const webInput = isRecord(input.web) ? input.web : {}
  const mcpInput = isRecord(input.mcp) ? input.mcp : {}
  const mcpAskInput = isRecord(input.mcpAsk) ? input.mcpAsk : {}
  const telegramInput = isRecord(input.telegram) ? input.telegram : {}
  const webAuthToken = mergeSecretField(current.web.authToken, webInput, 'authToken', {
    clearKey: 'clearAuthToken',
  })
  const telegramBotToken = mergeSecretField(current.telegram.botToken, telegramInput, 'botToken', {
    clearKey: 'clearBotToken',
    preserveMaskedPrefix: '****',
  })
  const mcpAskAuthToken = mergeSecretField(current.mcpAsk.authToken, mcpAskInput, 'authToken', {
    clearKey: 'clearAuthToken',
  })

  const merged: Config['connectors'] = {
    web: {
      port: resolveNumber(webInput, 'port', current.web.port),
      ...(webAuthToken ? { authToken: webAuthToken } : {}),
    },
    mcp: {
      port: resolveNumber(mcpInput, 'port', current.mcp.port),
    },
    mcpAsk: {
      enabled: resolveBoolean(mcpAskInput, 'enabled', current.mcpAsk.enabled),
      port: typeof mcpAskInput.port === 'number' ? mcpAskInput.port : current.mcpAsk.port,
      ...(mcpAskAuthToken ? { authToken: mcpAskAuthToken } : {}),
    },
    telegram: {
      enabled: resolveBoolean(telegramInput, 'enabled', current.telegram.enabled),
      botUsername: resolveOptionalString(telegramInput, 'botUsername', current.telegram.botUsername),
      chatIds: resolveNumberArray(telegramInput, 'chatIds', current.telegram.chatIds),
      ...(telegramBotToken ? { botToken: telegramBotToken } : {}),
    },
  }

  return writeConfigSection('connectors', merged) as Promise<Config['connectors']>
}

/** Config routes: GET /, PUT /ai-provider, PUT /:section, GET /api-keys/status */
export function createConfigRoutes(opts?: ConfigRouteOpts) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const config = await loadConfig()
      return c.json(toClientConfig(config))
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/ai-provider', async (c) => {
    try {
      const body = await c.req.json<{ backend?: string }>()
      const backend = body.backend
      if (backend !== 'claude-code' && backend !== 'codex-cli' && backend !== 'vercel-ai-sdk') {
        return c.json({ error: 'Invalid backend. Must be "claude-code", "codex-cli", or "vercel-ai-sdk".' }, 400)
      }
      await writeAIConfig(backend as AIBackend)
      return c.json({ backend })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/:section', async (c) => {
    try {
      const section = c.req.param('section') as ConfigSection
      if (!validSections.includes(section)) {
        return c.json({ error: `Invalid section "${section}". Valid: ${validSections.join(', ')}` }, 400)
      }
      const body = await c.req.json()
      switch (section) {
        case 'connectors': {
          const validated = await writeConnectorsSection(body)
          void opts?.onConnectorsChange?.().catch((err) => {
            console.error('config: connector reconcile failed:', err)
          })
          return c.json({
            data: toClientConnectorsConfig(validated),
            meta: { reconnectScheduled: true },
          })
        }
        case 'aiProvider': {
          const validated = await writeAiProviderSection(body)
          return c.json(toClientAiProviderConfig(validated))
        }
        case 'openbb': {
          const validated = await writeOpenbbSection(body)
          return c.json(toClientOpenbbConfig(validated))
        }
        default: {
          const validated = await writeConfigSection(section, body)
          return c.json(validated)
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/api-keys/status', async (c) => {
    try {
      const config = await readAIProviderConfig()
      return c.json({
        anthropic: !!config.apiKeys.anthropic,
        openai: !!config.apiKeys.openai,
        google: !!config.apiKeys.google,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}

/** OpenBB routes: POST /test-provider */
export function createOpenbbRoutes() {
  const TEST_ENDPOINTS: Record<string, { credField: string; path: string }> = {
    fred:             { credField: 'fred_api_key',             path: '/api/v1/economy/fred_search?query=GDP&provider=fred' },
    bls:              { credField: 'bls_api_key',              path: '/api/v1/economy/survey/bls_search?query=unemployment&provider=bls' },
    eia:              { credField: 'eia_api_key',              path: '/api/v1/commodity/short_term_energy_outlook?provider=eia' },
    econdb:           { credField: 'econdb_api_key',           path: '/api/v1/economy/available_indicators?provider=econdb' },
    fmp:              { credField: 'fmp_api_key',              path: '/api/v1/equity/screener?provider=fmp&limit=1' },
    nasdaq:           { credField: 'nasdaq_api_key',           path: '/api/v1/equity/search?query=AAPL&provider=nasdaq&is_symbol=true' },
    intrinio:         { credField: 'intrinio_api_key',         path: '/api/v1/equity/search?query=AAPL&provider=intrinio&limit=1' },
    tradingeconomics: { credField: 'tradingeconomics_api_key', path: '/api/v1/economy/calendar?provider=tradingeconomics' },
  }

  const app = new Hono()

  app.post('/test-provider', async (c) => {
    try {
      const { provider, key } = await c.req.json<{ provider: string; key: string }>()
      const endpoint = TEST_ENDPOINTS[provider]
      if (!endpoint) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400)
      if (!key) return c.json({ ok: false, error: 'No API key provided' }, 400)

      const openbbConfig = await readOpenbbConfig()
      const credHeader = JSON.stringify({ [endpoint.credField]: key })
      const url = `${openbbConfig.apiUrl}${endpoint.path}`

      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'X-OpenBB-Credentials': credHeader },
      })

      if (res.ok) return c.json({ ok: true })
      const body = await res.text().catch(() => '')
      return c.json({ ok: false, error: `OpenBB returned ${res.status}: ${body.slice(0, 200)}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: msg.includes('timeout') ? 'Cannot reach OpenBB API' : msg })
    }
  })

  return app
}
