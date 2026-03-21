import { Hono } from 'hono'
import {
  loadConfig,
  writeConfigSection,
  readAIProviderConfig,
  validSections,
  type ConfigSection,
  type Config,
  writeAIConfig,
  type AIBackend,
} from '../../../core/config.js'
import {
  hasOwn,
  isRecord,
  mergeSecretField,
  mergeSecretRecord,
  toSecretPresenceMap,
  withSecretPresence,
} from './secret-fields.js'
import { getValidationErrorPayload } from './zod-error.js'
import { getAIBackendErrorMessage, isAIBackend } from '../../../core/ai-backends.js'

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

function toClientConnectorsConfig(connectors: Config['connectors']) {
  return {
    ...connectors,
    web: withSecretPresence({
      host: connectors.web.host,
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
      host: resolveString(webInput, 'host', current.web.host),
      port: resolveNumber(webInput, 'port', current.web.port),
      ...(webAuthToken ? { authToken: webAuthToken } : {}),
    },
    mcp: {
      host: resolveString(mcpInput, 'host', current.mcp.host),
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
      if (!isAIBackend(backend)) {
        return c.json({ error: getAIBackendErrorMessage() }, 400)
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
        default: {
          const validated = await writeConfigSection(section, body)
          return c.json(validated)
        }
      }
    } catch (err) {
      const validationError = getValidationErrorPayload(err)
      if (validationError) {
        return c.json(validationError, 400)
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
