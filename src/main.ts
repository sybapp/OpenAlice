/**
 * Main entry point — thin orchestrator.
 *
 * All heavy lifting is delegated to bootstrap modules under src/bootstrap/.
 */

import { loadConfig } from './core/config.js'
import type { EngineContext } from './core/types.js'
import { SessionStore } from './core/session.js'
import { ConnectorCenter } from './core/connector-center.js'
import { createCronListener } from './jobs/cron/index.js'
import { createHeartbeat } from './jobs/heartbeat/index.js'
import {
  createTraderJobEngine,
  createTraderListener,
  createTraderReviewJobEngine,
  createTraderReviewListener,
  runTraderReview,
} from './jobs/strategies/index.js'
import { NewsCollector } from './domains/research/news-collector/index.js'
import { ensureDefaultSkillPacks } from './skills/registry.js'

import { migrateFilesystemLayout } from './bootstrap/migrate-filesystem.js'
import { initTradingAccounts, createAccountReconnector, teardownAccountRuntime } from './bootstrap/trading-accounts.js'
import { initServices } from './bootstrap/services.js'
import { registerAllTools } from './bootstrap/tools.js'
import { initAIProviders } from './bootstrap/ai.js'
import { initConnectors, createConnectorReconnector } from './bootstrap/connectors.js'
import { startPlugins, stopPlugins } from './bootstrap/plugin-lifecycle.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let startupCleanup: null | (() => Promise<void>) = null

async function runCleanupStep(errors: string[], label: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    errors.push(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main() {
  let cleanupStarted = false
  let cleanupResources: null | (() => Promise<void>) = null
  let pluginsStarted = false

  const runCleanup = async () => {
    if (cleanupStarted) return
    cleanupStarted = true
    await cleanupResources?.()
  }

  startupCleanup = runCleanup

  await migrateFilesystemLayout()
  const config = await loadConfig()
  await ensureDefaultSkillPacks()

  // ---- Trading Accounts ----
  const { accountManager, accountSetups, ccxtInitPromise, prepareAccountRuntime } = await initTradingAccounts()

  // ---- Services (Brain, EventLog, Cron, News, OHLCV) ----
  const services = await initServices(config)
  const {
    brain,
    instructions,
    eventLog,
    cronEngine,
    newsStore,
    marketData,
    ohlcvStore,
  } = services

  // ---- Tool Center ----
  const toolCenter = await registerAllTools({ config, accountManager, accountSetups, services, brain })

  // ---- AI Providers & Engine ----
  // ---- Connector Center ----
  const connectorCenter = new ConnectorCenter(eventLog)
  const getAccountGit = (id: string) => accountSetups.get(id)?.git

  // ---- AI Providers & Engine ----
  const { engine, backtest } = initAIProviders(config, toolCenter, instructions, {
    brain,
    eventLog,
    accountManager,
    marketData,
    ohlcvStore,
    newsStore,
    getAccountGit,
  })

  // ---- Cron Lifecycle ----
  await cronEngine.start()
  const trader = createTraderJobEngine({ eventLog })
  await trader.start()
  const traderReview = createTraderReviewJobEngine({ eventLog })
  await traderReview.start()
  const cronSession = new SessionStore('cron/default')
  await cronSession.restore()
  const cronListener = createCronListener({ connectorCenter, eventLog, engine, session: cronSession })
  cronListener.start()
  const traderListener = createTraderListener({
    config,
    engine,
    eventLog,
    brain,
    accountManager,
    marketData,
    ohlcvStore,
    newsStore,
    getAccountGit: (id) => accountSetups.get(id)?.git,
  })
  traderListener.start()
  const traderReviewListener = createTraderReviewListener({
    config,
    engine,
    eventLog,
    brain,
    accountManager,
    marketData,
    ohlcvStore,
    newsStore,
    getAccountGit: (id) => accountSetups.get(id)?.git,
  })
  traderReviewListener.start()
  console.log('cron: engine + listener started')
  // ---- Heartbeat ----
  const heartbeat = createHeartbeat({
    config: config.heartbeat,
    connectorCenter, cronEngine, eventLog, engine,
  })
  await heartbeat.start()
  if (config.heartbeat.enabled) {
    console.log(`heartbeat: enabled (every ${config.heartbeat.every})`)
  }

  // ---- News Collector ----
  let newsCollector: NewsCollector | null = null
  if (config.newsCollector.enabled && config.newsCollector.feeds.length > 0) {
    newsCollector = new NewsCollector({
      store: newsStore,
      feeds: config.newsCollector.feeds,
      intervalMs: config.newsCollector.intervalMinutes * 60 * 1000,
    })
    newsCollector.start()
    console.log(`news-collector: started (${config.newsCollector.feeds.length} feeds, every ${config.newsCollector.intervalMinutes}m)`)
  }

  // ---- Plugins ----
  const { coreConnectors, optionalConnectors } = initConnectors(config, toolCenter)

  // ---- Reconnect handlers ----
  const reconnectAccount = createAccountReconnector({ accountManager, accountSetups, prepareAccountRuntime })
  let ctx: EngineContext
  const reconnectConnectors = createConnectorReconnector({ coreConnectors, optionalConnectors, getCtx: () => ctx })
  const getConnectors = () => [...coreConnectors, ...optionalConnectors.values()]

  // ---- Engine Context ----
  ctx = {
    config, connectorCenter, engine, eventLog, heartbeat, cronEngine, trader, traderReview, toolCenter,
    accountManager, backtest, marketData,
    getAccountGit,
    reconnectAccount,
    removeTradingAccountRuntime: (accountId) => teardownAccountRuntime({ accountId, accountManager, accountSetups }),
    reconnectConnectors,
    runTraderReview: (strategyId) => runTraderReview(strategyId, {
      config,
      engine,
      eventLog,
      brain,
      accountManager,
      marketData,
      ohlcvStore,
      newsStore,
      getAccountGit,
    }),
  }

  cleanupResources = async () => {
    const cleanupErrors: string[] = []

    await runCleanupStep(cleanupErrors, 'news collector stop', () => newsCollector?.stop())
    await runCleanupStep(cleanupErrors, 'heartbeat stop', () => heartbeat.stop())
    await runCleanupStep(cleanupErrors, 'cron listener stop', () => cronListener.stop())
    await runCleanupStep(cleanupErrors, 'cron engine stop', () => cronEngine.stop())
    await runCleanupStep(cleanupErrors, 'trader listener stop', () => traderListener.stop())
    await runCleanupStep(cleanupErrors, 'trader stop', () => trader.stop())
    await runCleanupStep(cleanupErrors, 'trader review listener stop', () => traderReviewListener.stop())
    await runCleanupStep(cleanupErrors, 'trader review stop', () => traderReview.stop())
    if (pluginsStarted) {
      await runCleanupStep(cleanupErrors, 'plugin shutdown', () => stopPlugins(getConnectors()))
    }
    for (const [accountId, setup] of accountSetups.entries()) {
      await runCleanupStep(cleanupErrors, `account ${accountId} dispatcher dispose`, () => setup.disposeDispatcher())
    }
    await runCleanupStep(cleanupErrors, 'news store close', () => newsStore.close())
    await runCleanupStep(cleanupErrors, 'event log close', () => eventLog.close())
    await runCleanupStep(cleanupErrors, 'account manager closeAll', () => accountManager.closeAll())

    if (cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join('; '))
    }
  }

  await startPlugins(getConnectors(), ctx)
  pluginsStarted = true

  console.log('engine: started')

  await ccxtInitPromise

  // ---- Shutdown ----
  let stopped = false
  const shutdown = async () => {
    stopped = true
    await runCleanup()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ---- Tick Loop ----
  while (!stopped) {
    await sleep(config.engine.interval)
  }
}

main().catch(async (err) => {
  let fatal = err
  try {
    await startupCleanup?.()
  } catch (cleanupErr) {
    const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
    const original = err instanceof Error ? err.message : String(err)
    fatal = new Error(`${original}; startup cleanup failed: ${message}`)
  }
  console.error('fatal:', fatal)
  process.exit(1)
})
