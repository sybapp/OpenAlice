import { beforeEach, describe, expect, it, vi } from 'vitest'

const migrateFilesystemLayout = vi.fn(async () => undefined)
const loadConfig = vi.fn(async () => ({
  heartbeat: { enabled: false, every: '1m' },
  engine: { interval: 60_000 },
  newsCollector: { enabled: false, feeds: [], intervalMinutes: 5 },
}))
const ensureDefaultSkillPacks = vi.fn(async () => undefined)

const disposeDispatcher = vi.fn()
const accountManager = { closeAll: vi.fn(async () => undefined) }
const accountSetups = new Map([['acct', { disposeDispatcher }]])
const ccxtInitError = new Error('ccxt init failed')
const ccxtInitPromise = {
  then: (_resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => reject?.(ccxtInitError),
} as Promise<never>
const initTradingAccounts = vi.fn(async () => ({
  accountManager,
  accountSetups,
  ccxtInitPromise,
  prepareAccountRuntime: vi.fn(),
}))
const createAccountReconnector = vi.fn(() => vi.fn())
const teardownAccountRuntime = vi.fn(async () => undefined)

const eventLog = { close: vi.fn(async () => undefined) }
const cronEngine = {
  start: vi.fn(async () => undefined),
  stop: vi.fn(),
}
const newsStore = { close: vi.fn(async () => undefined) }
const initServices = vi.fn(async () => ({
  brain: {},
  instructions: 'instructions',
  eventLog,
  cronEngine,
  newsStore,
  marketData: {},
  ohlcvStore: {},
}))

const registerAllTools = vi.fn(async () => ({}))
const initAIProviders = vi.fn(() => ({ engine: {}, backtest: {} }))

const coreConnector = { name: 'core', start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
const initConnectors = vi.fn(() => ({
  coreConnectors: [coreConnector],
  optionalConnectors: new Map(),
}))
const createConnectorReconnector = vi.fn(() => vi.fn())
const startPlugins = vi.fn(async () => undefined)
const stopPlugins = vi.fn(async () => undefined)

const cronListener = { start: vi.fn(), stop: vi.fn() }
const createCronListener = vi.fn(() => cronListener)

const heartbeat = { start: vi.fn(async () => undefined), stop: vi.fn() }
const createHeartbeat = vi.fn(() => heartbeat)

const trader = { start: vi.fn(async () => undefined), stop: vi.fn() }
const traderReview = { start: vi.fn(async () => undefined), stop: vi.fn() }
const traderListener = { start: vi.fn(), stop: vi.fn() }
const traderReviewListener = { start: vi.fn(), stop: vi.fn() }
const createTraderJobEngine = vi.fn(() => trader)
const createTraderReviewJobEngine = vi.fn(() => traderReview)
const createTraderListener = vi.fn(() => traderListener)
const createTraderReviewListener = vi.fn(() => traderReviewListener)
const runTraderReview = vi.fn()

const restore = vi.fn(async () => undefined)
const SessionStore = vi.fn(function SessionStore() {
  return { restore }
})
const ConnectorCenter = vi.fn(function ConnectorCenter() {
  return {}
})
const NewsCollector = vi.fn(function NewsCollector() {
  return { start: vi.fn(), stop: vi.fn() }
})

vi.mock('./bootstrap/migrate-filesystem.js', () => ({ migrateFilesystemLayout }))
vi.mock('./core/config.js', () => ({ loadConfig }))
vi.mock('./skills/registry.js', () => ({ ensureDefaultSkillPacks }))
vi.mock('./bootstrap/trading-accounts.js', () => ({
  initTradingAccounts,
  createAccountReconnector,
  teardownAccountRuntime,
}))
vi.mock('./bootstrap/services.js', () => ({ initServices }))
vi.mock('./bootstrap/tools.js', () => ({ registerAllTools }))
vi.mock('./bootstrap/ai.js', () => ({ initAIProviders }))
vi.mock('./bootstrap/connectors.js', () => ({ initConnectors, createConnectorReconnector }))
vi.mock('./bootstrap/plugin-lifecycle.js', () => ({ startPlugins, stopPlugins }))
vi.mock('./jobs/cron/index.js', () => ({ createCronListener }))
vi.mock('./jobs/heartbeat/index.js', () => ({ createHeartbeat }))
vi.mock('./jobs/strategies/index.js', () => ({
  createTraderJobEngine,
  createTraderListener,
  createTraderReviewJobEngine,
  createTraderReviewListener,
  runTraderReview,
}))
vi.mock('./core/session.js', () => ({ SessionStore }))
vi.mock('./core/connector-center.js', () => ({ ConnectorCenter }))
vi.mock('./domains/research/news-collector/index.js', () => ({ NewsCollector }))

describe('main startup cleanup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    startPlugins.mockImplementation(async () => undefined)
  })

  it('cleans up started runtime resources when connector startup fails', async () => {
    const startupError = new Error('plugin bind failed')
    startPlugins.mockRejectedValueOnce(startupError)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await import('./main.ts')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))

    expect(stopPlugins).not.toHaveBeenCalled()
    expect(heartbeat.stop).toHaveBeenCalledOnce()
    expect(cronListener.stop).toHaveBeenCalledOnce()
    expect(cronEngine.stop).toHaveBeenCalledOnce()
    expect(traderListener.stop).toHaveBeenCalledOnce()
    expect(trader.stop).toHaveBeenCalledOnce()
    expect(traderReviewListener.stop).toHaveBeenCalledOnce()
    expect(traderReview.stop).toHaveBeenCalledOnce()
    expect(newsStore.close).toHaveBeenCalledOnce()
    expect(eventLog.close).toHaveBeenCalledOnce()
    expect(accountManager.closeAll).toHaveBeenCalledOnce()
    expect(disposeDispatcher).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith('fatal:', startupError)

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('cleans up started runtime resources when late startup fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await import('./main.ts')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))

    expect(stopPlugins).toHaveBeenCalledWith([coreConnector])
    expect(heartbeat.stop).toHaveBeenCalledOnce()
    expect(cronListener.stop).toHaveBeenCalledOnce()
    expect(cronEngine.stop).toHaveBeenCalledOnce()
    expect(traderListener.stop).toHaveBeenCalledOnce()
    expect(trader.stop).toHaveBeenCalledOnce()
    expect(traderReviewListener.stop).toHaveBeenCalledOnce()
    expect(traderReview.stop).toHaveBeenCalledOnce()
    expect(newsStore.close).toHaveBeenCalledOnce()
    expect(eventLog.close).toHaveBeenCalledOnce()
    expect(accountManager.closeAll).toHaveBeenCalledOnce()
    expect(disposeDispatcher).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith('fatal:', ccxtInitError)

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('continues cleanup and reports aggregated cleanup failures when plugin shutdown fails', async () => {
    stopPlugins.mockRejectedValueOnce(new Error('core stop failed'))
    eventLog.close.mockRejectedValueOnce(new Error('event log busy'))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await import('./main.ts')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))

    expect(stopPlugins).toHaveBeenCalledWith([coreConnector])
    expect(newsStore.close).toHaveBeenCalledOnce()
    expect(eventLog.close).toHaveBeenCalledOnce()
    expect(accountManager.closeAll).toHaveBeenCalledOnce()
    expect(disposeDispatcher).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith(
      'fatal:',
      expect.objectContaining({
        message: 'ccxt init failed; startup cleanup failed: plugin shutdown failed: core stop failed; event log close failed: event log busy',
      }),
    )

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
