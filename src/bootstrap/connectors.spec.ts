import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  webInstances: [] as FakeWebPlugin[],
  mcpAskInstances: [] as FakeMcpAskPlugin[],
  telegramInstances: [] as FakeTelegramPlugin[],
}))

class FakeMcpPlugin {
  constructor(public tools: unknown, public port: number) {}
  start = vi.fn()
  stop = vi.fn()
}

class FakeWebPlugin {
  config: { port: number; authToken?: string }
  start = vi.fn()
  stop = vi.fn()
  reconfigure = vi.fn(async () => 'unchanged' as const)

  constructor(config: { port: number; authToken?: string }) {
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

vi.mock('../plugins/mcp.js', () => ({
  McpPlugin: FakeMcpPlugin,
}))

vi.mock('../connectors/web/index.js', () => ({
  WebPlugin: FakeWebPlugin,
}))

vi.mock('../connectors/mcp-ask/index.js', () => ({
  McpAskPlugin: FakeMcpAskPlugin,
}))

vi.mock('../connectors/telegram/index.js', () => ({
  TelegramPlugin: FakeTelegramPlugin,
}))

const { initPlugins, createConnectorReconnector } = await import('./connectors.js')

describe('bootstrap connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.webInstances.length = 0
    mocks.mcpAskInstances.length = 0
    mocks.telegramInstances.length = 0
  })

  it('initializes core and optional plugins from connector config', () => {
    const result = initPlugins({
      connectors: {
        web: { port: 3002, authToken: 'web-secret' },
        mcp: { port: 3001 },
        mcpAsk: { enabled: true, port: 3003, authToken: 'ask-secret' },
        telegram: { enabled: true, botToken: 'tg-secret', chatIds: [123] },
      },
    } as never, {} as never)

    expect(result.corePlugins).toHaveLength(2)
    expect(result.optionalPlugins.has('mcp-ask')).toBe(true)
    expect(result.optionalPlugins.has('telegram')).toBe(true)
    expect(mocks.webInstances[0].config).toEqual({ port: 3002, authToken: 'web-secret' })
    expect(mocks.mcpAskInstances).toHaveLength(1)
    expect(mocks.telegramInstances).toHaveLength(1)
  })

  it('reconfigures web and restarts optional plugins when connector config changes', async () => {
    const web = new FakeWebPlugin({ port: 3002, authToken: 'old-token' })
    web.reconfigure.mockResolvedValue('updated')
    const telegram = new FakeTelegramPlugin({ token: 'old-tg-token', allowedChatIds: [123] })
    const optionalPlugins = new Map<string, any>([['telegram', telegram]])

    mocks.loadConfig.mockResolvedValue({
      connectors: {
        web: { port: 3010, authToken: 'new-token' },
        mcp: { port: 3001 },
        mcpAsk: { enabled: true, port: 3003, authToken: 'ask-token' },
        telegram: { enabled: true, botToken: 'new-tg-token', chatIds: [123, 456] },
      },
    })

    const reconnect = createConnectorReconnector({
      corePlugins: [web as never],
      optionalPlugins,
      getCtx: () => ({ ctx: 'engine' } as never),
    })

    const result = await reconnect()

    expect(result).toEqual({
      success: true,
      message: 'web updated, mcp-ask started, telegram restarted',
    })
    expect(web.reconfigure).toHaveBeenCalledWith({ port: 3010, authToken: 'new-token' })
    expect(telegram.stop).toHaveBeenCalled()
    expect(optionalPlugins.get('mcp-ask')).toBeInstanceOf(FakeMcpAskPlugin)
    expect(optionalPlugins.get('telegram')).toBeInstanceOf(FakeTelegramPlugin)
    expect(mocks.telegramInstances.at(-1)?.getConfig()).toEqual({
      token: 'new-tg-token',
      allowedChatIds: [123, 456],
    })
  })
})
