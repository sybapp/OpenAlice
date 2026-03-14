import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  webInstances: [] as FakeWebPlugin[],
  mcpAskInstances: [] as FakeMcpAskPlugin[],
  telegramInstances: [] as FakeTelegramPlugin[],
}))

class FakeMcpPlugin {
  config: { host: string; port: number }
  start = vi.fn()
  stop = vi.fn()
  reconfigure = vi.fn(async () => 'unchanged' as const)

  constructor(public tools: unknown, config: { host: string; port: number }) {
    this.config = config
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
}

class FakeMcpAskPlugin {
  start = vi.fn(async () => undefined)
  stop = vi.fn(async () => undefined)

  constructor(private config: { port: number; authToken?: string }) {
    mocks.mcpAskInstances.push(this)
  }

  getConfig() {
    return this.config
  }
}

class FakeTelegramPlugin {
  start = vi.fn(async () => undefined)
  stop = vi.fn(async () => undefined)

  constructor(private config: { token: string; allowedChatIds: number[] }) {
    mocks.telegramInstances.push(this)
  }

  getConfig() {
    return this.config
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
    mocks.webInstances.length = 0
    mocks.mcpAskInstances.length = 0
    mocks.telegramInstances.length = 0
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
})
