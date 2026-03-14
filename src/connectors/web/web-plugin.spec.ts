import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class FakeSessionStore {
    restore = vi.fn(async () => undefined)
    appendAssistant = vi.fn(async () => undefined)

    constructor(public id: string) {
      mocks.sessionInstances.push(this)
    }
  }

  return {
    sessionInstances: [] as InstanceType<typeof FakeSessionStore>[],
    serve: vi.fn(),
    serveStatic: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    persistMedia: vi.fn(async () => '2026-03-13/test-image.png'),
    createAuthMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    createChatRoutes: vi.fn(() => new Hono()),
    createMediaRoutes: vi.fn(() => new Hono()),
    createConfigRoutes: vi.fn(() => new Hono()),
    createOpenbbRoutes: vi.fn(() => new Hono()),
    createEventsRoutes: vi.fn(() => new Hono()),
    createCronRoutes: vi.fn(() => new Hono()),
    createHeartbeatRoutes: vi.fn(() => new Hono()),
    createTradingRoutes: vi.fn(() => new Hono()),
    createTradingConfigRoutes: vi.fn(() => new Hono()),
    createDevRoutes: vi.fn(() => new Hono()),
    createToolsRoutes: vi.fn(() => new Hono()),
    createBacktestRoutes: vi.fn(() => new Hono()),
    createTraderRoutes: vi.fn(() => new Hono()),
    SessionStore: FakeSessionStore,
  }
})

vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}))

vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic: mocks.serveStatic,
}))

vi.mock('../../core/session.js', () => ({
  SessionStore: mocks.SessionStore,
}))

vi.mock('../../core/media-store.js', () => ({
  persistMedia: mocks.persistMedia,
}))

vi.mock('./auth-middleware.js', () => ({
  createAuthMiddleware: mocks.createAuthMiddleware,
}))

vi.mock('./routes/chat.js', () => ({
  createChatRoutes: mocks.createChatRoutes,
  createMediaRoutes: mocks.createMediaRoutes,
}))

vi.mock('./routes/config.js', () => ({
  createConfigRoutes: mocks.createConfigRoutes,
  createOpenbbRoutes: mocks.createOpenbbRoutes,
}))

vi.mock('./routes/events.js', () => ({
  createEventsRoutes: mocks.createEventsRoutes,
}))

vi.mock('./routes/cron.js', () => ({
  createCronRoutes: mocks.createCronRoutes,
}))

vi.mock('./routes/heartbeat.js', () => ({
  createHeartbeatRoutes: mocks.createHeartbeatRoutes,
}))

vi.mock('./routes/trading.js', () => ({
  createTradingRoutes: mocks.createTradingRoutes,
}))

vi.mock('./routes/trading-config.js', () => ({
  createTradingConfigRoutes: mocks.createTradingConfigRoutes,
}))

vi.mock('./routes/dev.js', () => ({
  createDevRoutes: mocks.createDevRoutes,
}))

vi.mock('./routes/tools.js', () => ({
  createToolsRoutes: mocks.createToolsRoutes,
}))

vi.mock('./routes/backtest.js', () => ({
  createBacktestRoutes: mocks.createBacktestRoutes,
}))

vi.mock('./routes/trader.js', () => ({
  createTraderRoutes: mocks.createTraderRoutes,
}))

const { WebPlugin } = await import('./web-plugin.js')

describe('WebPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionInstances.length = 0
    mocks.serve.mockReturnValue({ close: vi.fn() })
  })

  it('starts the web server and registers a web connector', async () => {
    const register = vi.fn(() => vi.fn())
    const ctx = {
      connectorCenter: { register },
      reconnectConnectors: vi.fn(),
      eventLog: {},
      cronEngine: {},
      trader: {},
      traderReview: {},
      heartbeat: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
      engine: {},
    } as never

    const plugin = new WebPlugin({ host: '127.0.0.1', port: 3200, authToken: 'secret' })
    await plugin.start(ctx)

    expect(mocks.serve).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1', port: 3200, fetch: expect.any(Function) }),
      expect.any(Function),
    )
    expect(register).toHaveBeenCalledTimes(1)
    expect(mocks.createConfigRoutes).toHaveBeenCalledWith({
      onConnectorsChange: expect.any(Function),
    })
    const sessionInstance = mocks.sessionInstances[0]
    expect(sessionInstance.restore).toHaveBeenCalled()
  })

  it('persists connector media, notifies SSE clients, and appends assistant history', async () => {
    const register = vi.fn(() => vi.fn())
    const ctx = {
      connectorCenter: { register },
      reconnectConnectors: vi.fn(),
      eventLog: {},
      cronEngine: {},
      trader: {},
      traderReview: {},
      heartbeat: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
      engine: {},
    } as never

    const plugin = new WebPlugin({ host: '127.0.0.1', port: 3201 })
    await plugin.start(ctx)

    const connector = register.mock.calls[0]?.[0]
    const sseClient = { id: 'client-1', send: vi.fn() }
    ;(plugin as unknown as { sseClients: Map<string, typeof sseClient> }).sseClients.set('client-1', sseClient)

    const result = await connector.send({
      kind: 'assistant',
      text: 'Trade idea',
      source: 'engine',
      media: [{ type: 'image', path: '/tmp/snapshot.png' }],
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.persistMedia).toHaveBeenCalledWith('/tmp/snapshot.png')
    expect(sseClient.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'message',
      kind: 'assistant',
      text: 'Trade idea',
      media: [{ type: 'image', url: '/api/media/2026-03-13/test-image.png' }],
      source: 'engine',
    }))
    const sessionInstance = mocks.sessionInstances[0]
    expect(sessionInstance.appendAssistant).toHaveBeenCalledWith(
      [
        { type: 'text', text: 'Trade idea' },
        { type: 'image', url: '/api/media/2026-03-13/test-image.png' },
      ],
      'engine',
      { kind: 'assistant', source: 'engine' },
    )
  })

  it('restarts the server when the port changes and updates in place when only auth changes', async () => {
    const register = vi.fn(() => vi.fn())
    const ctx = {
      connectorCenter: { register },
      reconnectConnectors: vi.fn(),
      eventLog: {},
      cronEngine: {},
      trader: {},
      traderReview: {},
      heartbeat: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
      engine: {},
    } as never
    const unregister = vi.fn()
    const close = vi.fn()
    register.mockReturnValue(unregister)
    mocks.serve.mockReturnValue({ close })

    const plugin = new WebPlugin({ host: '127.0.0.1', port: 3202, authToken: 'old' })
    await plugin.start(ctx)

    await expect(plugin.reconfigure({ host: '127.0.0.1', port: 3202, authToken: 'new' })).resolves.toBe('updated')
    expect(close).not.toHaveBeenCalled()

    await expect(plugin.reconfigure({ host: '127.0.0.1', port: 3300, authToken: 'new' })).resolves.toBe('restarted')
    expect(unregister).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    expect(mocks.serve).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1', port: 3300, fetch: expect.any(Function) }),
      expect.any(Function),
    )
  })

  it('reports unchanged config and cleans up server state on stop', async () => {
    const unregister = vi.fn()
    const close = vi.fn()
    const register = vi.fn(() => unregister)
    mocks.serve.mockReturnValue({ close })

    const plugin = new WebPlugin({ host: '127.0.0.1', port: 3205, authToken: 'same-token' })
    await plugin.start({
      connectorCenter: { register },
      reconnectConnectors: vi.fn(),
      eventLog: {},
      cronEngine: {},
      trader: {},
      traderReview: {},
      heartbeat: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
      engine: {},
    } as never)

    const sseClients = (plugin as unknown as { sseClients: Map<string, { send: () => void }> }).sseClients
    sseClients.set('client-1', { send: vi.fn() })

    await expect(plugin.reconfigure({ host: '127.0.0.1', port: 3205, authToken: 'same-token' })).resolves.toBe('unchanged')
    await plugin.stop()

    expect(unregister).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    expect(sseClients.size).toBe(0)
  })
})
