import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigSection: vi.fn(),
  writeAIConfig: vi.fn(),
  readAIProviderConfig: vi.fn(),
}))

vi.mock('../../../core/config.js', () => ({
  loadConfig: mocks.loadConfig,
  writeConfigSection: mocks.writeConfigSection,
  writeAIConfig: mocks.writeAIConfig,
  readAIProviderConfig: mocks.readAIProviderConfig,
  validSections: ['connectors', 'aiProvider'],
}))

const { createConfigRoutes } = await import('./config.js')

const fullConfig = {
  aiProvider: {
    backend: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKeys: { anthropic: 'anthropic-secret' },
  },
  engine: { port: 3000, interval: 5000, pairs: ['BTC/USD'] },
  agent: {
    maxSteps: 20,
    evolutionMode: false,
    claudeCode: { disallowedTools: [], maxTurns: 20 },
    codexCli: {
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      configOverrides: [],
    },
  },
  crypto: { provider: { type: 'none' }, guards: [] },
  compaction: {
    maxContextTokens: 200_000,
    maxOutputTokens: 20_000,
    autoCompactBuffer: 13_000,
    microcompactKeepRecent: 3,
  },
  heartbeat: {
    enabled: false,
    every: '30m',
    prompt: 'prompt',
    activeHours: null,
  },
  connectors: {
    web: { host: '127.0.0.1', port: 3002, authToken: 'web-secret' },
    mcp: { host: '127.0.0.1', port: 3001 },
    mcpAsk: { enabled: false },
    telegram: {
      enabled: true,
      botToken: 'telegram-secret',
      botUsername: 'alice_bot',
      chatIds: [123],
    },
  },
  newsCollector: {
    enabled: false,
    intervalMinutes: 15,
    maxInMemory: 100,
    retentionDays: 7,
    feeds: [],
  },
  tools: { disabled: [] },
}

describe('createConfigRoutes', () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset()
    mocks.writeConfigSection.mockReset()
    mocks.writeAIConfig.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('masks connector secrets in the config payload while exposing hasAuthToken', async () => {
    mocks.loadConfig.mockResolvedValue(fullConfig)

    const app = createConfigRoutes()
    const res = await app.request('/')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.connectors.web).toEqual({ host: '127.0.0.1', port: 3002, hasAuthToken: true })
    expect(body.connectors.mcp).toEqual({ host: '127.0.0.1', port: 3001 })
    expect(body.connectors.mcpAsk).toEqual({ enabled: false, hasAuthToken: false })
    expect(body.connectors.telegram).toEqual({
      enabled: true,
      hasBotToken: true,
      botUsername: 'alice_bot',
      chatIds: [123],
    })
    expect(body.connectors.web.authToken).toBeUndefined()
    expect(body.aiProvider.apiKeys).toEqual({
      anthropic: true,
    })
  })

  it('rejects invalid config sections', async () => {
    const app = createConfigRoutes()
    const res = await app.request('/unknown', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Invalid section "unknown". Valid: connectors, aiProvider',
    })
  })

  it('wraps connector updates and preserves masked secrets when saving', async () => {
    mocks.loadConfig.mockResolvedValue(fullConfig)
    mocks.writeConfigSection.mockImplementation(async (_section, data) => data)
    const onConnectorsChange = vi.fn().mockResolvedValue(undefined)

    const app = createConfigRoutes({ onConnectorsChange })
    const res = await app.request('/connectors', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        web: { host: '0.0.0.0', port: 3010 },
        telegram: {
          enabled: true,
          botToken: '****cret',
          botUsername: 'alice_bot',
          chatIds: [123, 456],
        },
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('connectors', {
      web: { host: '0.0.0.0', port: 3010, authToken: 'web-secret' },
      mcp: { host: '127.0.0.1', port: 3001 },
      mcpAsk: { enabled: false },
      telegram: {
        enabled: true,
        botToken: 'telegram-secret',
        botUsername: 'alice_bot',
        chatIds: [123, 456],
      },
    })
    expect(body).toEqual({
      data: {
        web: { host: '0.0.0.0', port: 3010, hasAuthToken: true },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: false, hasAuthToken: false },
        telegram: {
          enabled: true,
          hasBotToken: true,
          botUsername: 'alice_bot',
          chatIds: [123, 456],
        },
      },
      meta: { reconnectScheduled: true },
    })
    expect(onConnectorsChange).toHaveBeenCalled()
  })

  it('supports clearing telegram and mcp-ask credentials without exposing their current values', async () => {
    mocks.loadConfig.mockResolvedValue({
      ...fullConfig,
      connectors: {
        ...fullConfig.connectors,
        mcpAsk: { enabled: true, port: 3003, authToken: 'mcp-secret' },
      },
    })
    mocks.writeConfigSection.mockImplementation(async (_section, data) => data)

    const app = createConfigRoutes()
    const res = await app.request('/connectors', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpAsk: { clearAuthToken: true },
        telegram: { clearBotToken: true },
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('connectors', {
      web: { host: '127.0.0.1', port: 3002, authToken: 'web-secret' },
      mcp: { host: '127.0.0.1', port: 3001 },
      mcpAsk: { enabled: true, port: 3003 },
      telegram: {
        enabled: true,
        botUsername: 'alice_bot',
        chatIds: [123],
      },
    })
    expect(body.data.mcpAsk).toEqual({ enabled: true, port: 3003, hasAuthToken: false })
    expect(body.data.telegram).toEqual({
      enabled: true,
      hasBotToken: false,
      botUsername: 'alice_bot',
      chatIds: [123],
    })
  })

  it('merges aiProvider key updates and clear operations without overwriting unrelated keys', async () => {
    mocks.loadConfig.mockResolvedValue({
      ...fullConfig,
      aiProvider: {
        ...fullConfig.aiProvider,
        apiKeys: {
          anthropic: 'anthropic-secret',
          openai: 'openai-secret',
        },
      },
    })
    mocks.writeConfigSection.mockImplementation(async (_section, data) => data)

    const app = createConfigRoutes()
    const res = await app.request('/aiProvider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5.2',
        apiKeys: {
          google: 'google-secret',
          openai: null,
        },
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('aiProvider', {
      backend: 'claude-code',
      provider: 'openai',
      model: 'gpt-5.2',
      apiKeys: {
        anthropic: 'anthropic-secret',
        google: 'google-secret',
      },
    })
    expect(body.apiKeys).toEqual({
      anthropic: true,
      google: true,
    })
  })

  it('rejects invalid ai backends when switching providers', async () => {
    const app = createConfigRoutes()
    const res = await app.request('/ai-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backend: 'unsupported-backend',
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Invalid backend. Must be "claude-code", "codex-cli", or "vercel-ai-sdk".',
    })
  })

  it('returns structured zod issues when a config write fails validation', async () => {
    mocks.loadConfig.mockResolvedValue(fullConfig)
    mocks.writeConfigSection.mockRejectedValue(new ZodError([
      {
        code: 'invalid_type',
        expected: 'number',
        input: 'oops',
        path: ['web', 'port'],
        message: 'Invalid input: expected number, received string',
      },
    ]))

    const app = createConfigRoutes()
    const res = await app.request('/connectors', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ web: { port: 'oops' } }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({
      error: 'Validation failed',
      details: [
        expect.objectContaining({
          code: 'invalid_type',
          path: ['web', 'port'],
        }),
      ],
    })
  })

  it('reports configured AI key presence through the status endpoint', async () => {
    mocks.readAIProviderConfig.mockResolvedValue({
      apiKeys: {
        anthropic: 'anthropic-secret',
        openai: '',
        google: 'google-secret',
      },
    })

    const app = createConfigRoutes()
    const res = await app.request('/api-keys/status')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: true,
      openai: false,
      google: true,
    })
  })

  it('allows clearing ai provider baseUrl while preserving unrelated api keys', async () => {
    mocks.loadConfig.mockResolvedValue({
      ...fullConfig,
      aiProvider: {
        ...fullConfig.aiProvider,
        baseUrl: 'https://proxy.example.com',
        apiKeys: {
          anthropic: 'anthropic-secret',
          openai: 'openai-secret',
        },
      },
    })
    mocks.writeConfigSection.mockImplementation(async (_section, data) => data)

    const app = createConfigRoutes()
    const res = await app.request('/aiProvider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        baseUrl: '',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('aiProvider', {
      backend: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKeys: {
        anthropic: 'anthropic-secret',
        openai: 'openai-secret',
      },
    })
    expect(body.apiKeys).toEqual({
      anthropic: true,
      openai: true,
    })
  })

})
