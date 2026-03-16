import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  mcpInstances: [] as FakeMcpPlugin[],
  webInstances: [] as FakeWebPlugin[],
  mcpAskInstances: [] as FakeMcpAskPlugin[],
  telegramInstances: [] as FakeTelegramPlugin[],
  mcpAskStartErrors: [] as unknown[],
  mcpAskStopErrors: [] as unknown[],
  telegramStartErrors: [] as unknown[],
  telegramStopErrors: [] as unknown[],
}))

class FakeMcpPlugin {
  config: { host: string; port: number }
  start = vi.fn()
  stop = vi.fn()
  reconfigure = vi.fn(async () => 'unchanged' as const)

  constructor(public tools: unknown, config: { host: string; port: number }) {
    this.config = config
    mocks.mcpInstances.push(this)
  }

  getConfig() {
    return this.config
  }
}

class FakeWebPlugin {
  config: { host: string; port: number; authToken?: string }
  start = vi.fn()
  stop = vi.fn()
  reconfigure = vi.fn(async () => 'unchanged' as const)

  constructor(config: { host: string; port: number; authToken?: string }) {
    this.config = config
    mocks.webInstances.push(this)
  }

  getConfig() {
    return this.config
  }
}

class FakeMcpAskPlugin {
  start = vi.fn(async () => {
    const error = mocks.mcpAskStartErrors.shift()
    if (error) throw error
  })
  stop = vi.fn(async () => {
    const error = mocks.mcpAskStopErrors.shift()
    if (error) throw error
  })

  constructor(private config: { port: number; authToken?: string }) {
    mocks.mcpAskInstances.push(this)
  }

  getConfig() {
    return this.config
  }
}

class FakeTelegramPlugin {
  healthy = true
  start = vi.fn(async () => {
    const error = mocks.telegramStartErrors.shift()
    if (error) throw error
    this.healthy = true
  })
  stop = vi.fn(async () => {
    const error = mocks.telegramStopErrors.shift()
    if (error) throw error
    this.healthy = false
  })

  constructor(private config: { token: string; allowedChatIds: number[] }) {
    mocks.telegramInstances.push(this)
  }

  getConfig() {
    return this.config
  }

  isHealthy() {
    return this.healthy
  }
}

vi.mock('../core/config.js', () => ({
  loadConfig: mocks.loadConfig,
}))

vi.mock('../connectors/mcp-server/index.js', () => ({
  McpServerConnector: FakeMcpPlugin,
}))

vi.mock('../connectors/web/index.js', () => ({
  WebConnector: FakeWebPlugin,
}))

vi.mock('../connectors/mcp-ask/index.js', () => ({
  McpAskConnector: FakeMcpAskPlugin,
}))

vi.mock('../connectors/telegram/index.js', () => ({
  TelegramConnector: FakeTelegramPlugin,
}))

const { initConnectors, createConnectorReconnector } = await import('./connectors.js')

describe('bootstrap connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mcpInstances.length = 0
    mocks.webInstances.length = 0
    mocks.mcpAskInstances.length = 0
    mocks.telegramInstances.length = 0
    mocks.mcpAskStartErrors.length = 0
    mocks.mcpAskStopErrors.length = 0
    mocks.telegramStartErrors.length = 0
    mocks.telegramStopErrors.length = 0
  })

  it('initializes core and optional connectors from connector config', () => {
    const result = initConnectors({
      connectors: {
        web: { host: '127.0.0.1', port: 3002, authToken: 'web-secret' },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: true, port: 3003, authToken: 'ask-secret' },
        telegram: { enabled: true, botToken: 'tg-secret', chatIds: [123] },
      },
    } as never, {} as never)

    expect(result.coreConnectors).toHaveLength(2)
    expect(result.optionalConnectors.has('mcp-ask')).toBe(true)
    expect(result.optionalConnectors.has('telegram')).toBe(true)
    expect(mocks.webInstances[0].config).toEqual({ host: '127.0.0.1', port: 3002, authToken: 'web-secret' })
    expect(mocks.mcpAskInstances).toHaveLength(1)
    expect(mocks.telegramInstances).toHaveLength(1)
  })

  it('reconfigures web and restarts optional plugins when connector config changes', async () => {
    const mcp = new FakeMcpPlugin({}, { host: '127.0.0.1', port: 3001 })
    mcp.reconfigure.mockResolvedValue('restarted')
    const web = new FakeWebPlugin({ host: '127.0.0.1', port: 3002, authToken: 'old-token' })
    web.reconfigure.mockResolvedValue('updated')
    const telegram = new FakeTelegramPlugin({ token: 'old-tg-token', allowedChatIds: [123] })
    const optionalConnectors = new Map<string, any>([['telegram', telegram]])

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3010, authToken: 'new-token' },
        mcp: { host: '127.0.0.1', port: 3101 },
        mcpAsk: { enabled: true, port: 3003, authToken: 'ask-token' },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123, 456] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors: [mcp as never, web as never],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    const result = await reconnect()

    expect(result).toEqual({
      success: true,
      message: 'web updated, mcp restarted on 127.0.0.1:3101, mcp-ask started, telegram restarted',
    })
    expect(web.reconfigure).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3010, authToken: 'new-token' })
    expect(mcp.reconfigure).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3101 })
    expect(telegram.stop).toHaveBeenCalled()
    expect(optionalConnectors.get('mcp-ask')).toBeInstanceOf(FakeMcpAskPlugin)
    expect(optionalConnectors.get('telegram')).toBeInstanceOf(FakeTelegramPlugin)
    expect(mocks.telegramInstances.at(-1)?.getConfig()).toEqual({
      token: 'new-tg-token',
      allowedChatIds: [123, 456],
    })
  })

  it('starts missing core connectors when reconnect loads valid web and mcp listener config', async () => {
    const coreConnectors: any[] = []

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3010, authToken: 'new-token' },
        mcp: { host: '127.0.0.1', port: 3101 },
        mcpAsk: { enabled: false },
        telegram: { enabled: false, chatIds: [] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors,
      optionalConnectors: new Map<string, any>(),
      getCtx: () => ({ ctx: 'engine', toolCenter: { label: 'tools' } } as never),
    })

    await expect(reconnect()).resolves.toEqual({
      success: true,
      message: 'web started on 127.0.0.1:3010, mcp started on 127.0.0.1:3101',
    })
    expect(coreConnectors).toHaveLength(2)
    expect(mocks.webInstances.at(-1)?.start).toHaveBeenCalledOnce()
    expect(mocks.mcpInstances.at(-1)?.start).toHaveBeenCalledOnce()
    expect(mocks.mcpInstances.at(-1)?.tools).toEqual({ label: 'tools' })
  })

  it('rolls back a newly started core connector when a later reconnect step fails', async () => {
    mocks.telegramStartErrors.push(new Error('bad token'))
    const coreConnectors: any[] = []

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3010, authToken: 'new-token' },
        mcp: { host: '127.0.0.1', port: 3101 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors,
      optionalConnectors: new Map<string, any>(),
      getCtx: () => ({ ctx: 'engine', toolCenter: { label: 'tools' } } as never),
    })

    await expect(reconnect()).resolves.toEqual({ success: false, error: 'bad token' })
    expect(coreConnectors).toHaveLength(0)
    expect(mocks.webInstances.at(-1)?.stop).toHaveBeenCalledOnce()
    expect(mocks.mcpInstances.at(-1)?.stop).toHaveBeenCalledOnce()
  })

  it('keeps a healthy optional connector online when refreshed config is incomplete', async () => {
    const mcp = new FakeMcpPlugin({}, { host: '127.0.0.1', port: 3001 })
    const web = new FakeWebPlugin({ host: '127.0.0.1', port: 3002 })
    const telegram = new FakeTelegramPlugin({ token: 'old-tg-token', allowedChatIds: [123] })
    const optionalConnectors = new Map<string, any>([['telegram', telegram]])

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3002 },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, chatIds: [456] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors: [mcp as never, web as never],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    await expect(reconnect()).resolves.toEqual({ success: true, message: 'no changes' })
    expect(telegram.stop).not.toHaveBeenCalled()
    expect(telegram.start).not.toHaveBeenCalled()
    expect(optionalConnectors.get('telegram')).toBe(telegram)
  })

  it('rolls back to the previous optional connector when restart fails', async () => {
    const telegram = new FakeTelegramPlugin({ token: 'old-tg-token', allowedChatIds: [123] })
    const optionalConnectors = new Map<string, any>([['telegram', telegram]])
    mocks.telegramStartErrors.push(new Error('bad token'))

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3002 },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors: [],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    await expect(reconnect()).resolves.toEqual({ success: false, error: 'bad token' })
    expect(telegram.stop).toHaveBeenCalledOnce()
    expect(telegram.start).toHaveBeenCalledOnce()
    expect(optionalConnectors.get('telegram')).toBe(telegram)
  })

  it('restarts an unhealthy optional connector even when config is unchanged', async () => {
    const mcp = new FakeMcpPlugin({}, { host: '127.0.0.1', port: 3001 })
    const web = new FakeWebPlugin({ host: '127.0.0.1', port: 3002 })
    const telegram = new FakeTelegramPlugin({ token: 'tg-token', allowedChatIds: [123] })
    telegram.healthy = false
    const optionalConnectors = new Map<string, any>([['telegram', telegram]])

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3002 },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, botToken: 'tg-token', chatIds: [123] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors: [mcp as never, web as never],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    await expect(reconnect()).resolves.toEqual({ success: true, message: 'telegram restarted' })
    expect(telegram.stop).toHaveBeenCalledOnce()
    expect(optionalConnectors.get('telegram')).toBeInstanceOf(FakeTelegramPlugin)
    expect(optionalConnectors.get('telegram')).not.toBe(telegram)
  })

  it('rolls back earlier connector updates when a later connector fails in the same batch', async () => {
    const mcp = new FakeMcpPlugin({}, { host: '127.0.0.1', port: 3001 })
    const web = new FakeWebPlugin({ host: '127.0.0.1', port: 3002, authToken: 'old-token' })
    web.reconfigure
      .mockResolvedValueOnce('updated')
      .mockResolvedValueOnce('updated')

    const telegram = new FakeTelegramPlugin({ token: 'old-tg-token', allowedChatIds: [123] })
    const optionalConnectors = new Map<string, any>([['telegram', telegram]])
    mocks.telegramStartErrors.push(new Error('bad token'))

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3002, authToken: 'new-token' },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors: [mcp as never, web as never],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    await expect(reconnect()).resolves.toEqual({ success: false, error: 'bad token' })
    expect(web.reconfigure).toHaveBeenNthCalledWith(1, { host: '127.0.0.1', port: 3002, authToken: 'new-token' })
    expect(web.reconfigure).toHaveBeenNthCalledWith(2, { host: '127.0.0.1', port: 3002, authToken: 'old-token' })
    expect(optionalConnectors.get('telegram')).toBe(telegram)
  })

  it('removes an optional connector from the live set when rollback stops the replacement but cannot restart the previous instance', async () => {
    const web = new FakeWebPlugin({ host: '127.0.0.1', port: 3002, authToken: 'old-token' })
    web.reconfigure
      .mockResolvedValueOnce('updated')
      .mockResolvedValueOnce('updated')

    const mcpAsk = new FakeMcpAskPlugin({ port: 3001, authToken: 'old-token' })
    mcpAsk.start.mockRejectedValueOnce(new Error('rollback restart failed'))
    const optionalConnectors = new Map<string, any>([['mcp-ask', mcpAsk]])
    mocks.telegramStartErrors.push(new Error('bad token'))

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3002, authToken: 'new-token' },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: true, port: 3003, authToken: 'new-token' },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123] },
      },
    })

    const reconnect = createConnectorReconnector({
      coreConnectors: [web as never],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    await expect(reconnect()).resolves.toEqual({
      success: false,
      error: 'bad token; batch rollback failed: rollback restart failed',
    })
    expect(optionalConnectors.has('mcp-ask')).toBe(false)
  })

  it('keeps a newly started optional connector in the live set when rollback cannot stop it', async () => {
    const web = new FakeWebPlugin({ host: '127.0.0.1', port: 3002, authToken: 'old-token' })
    web.reconfigure
      .mockResolvedValueOnce('updated')
      .mockResolvedValueOnce('updated')

    mocks.mcpAskStopErrors.push(new Error('stop failed'))
    mocks.telegramStartErrors.push(new Error('bad token'))

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { host: '127.0.0.1', port: 3002, authToken: 'new-token' },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: true, port: 3003, authToken: 'ask-token' },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123] },
      },
    })

    const optionalConnectors = new Map<string, any>()
    const reconnect = createConnectorReconnector({
      coreConnectors: [web as never],
      optionalConnectors,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    await expect(reconnect()).resolves.toEqual({
      success: false,
      error: 'bad token; batch rollback failed: stop failed',
    })
    expect(optionalConnectors.get('mcp-ask')).toBeInstanceOf(FakeMcpAskPlugin)
  })
})
