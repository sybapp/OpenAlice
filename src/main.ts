/**
 * Main entry point — thin orchestrator.
 *
 * All heavy lifting is delegated to bootstrap modules under src/bootstrap/.
 */

import { loadConfig } from './core/config.js'
import type { EngineContext } from './core/types.js'
import { SessionStore } from './core/session.js'
import { ConnectorCenter } from './core/connector-center.js'
import { CcxtAccount, createCcxtProviderTools } from './extension/trading/index.js'
import { createCronListener } from './task/cron/index.js'
import { createHeartbeat } from './task/heartbeat/index.js'
import { NewsCollector } from './extension/research/news-collector/index.js'
import { ensureDefaultSkillPacks } from './core/skills/registry.js'

import { initTradingAccounts, createAccountReconnector } from './bootstrap/trading-accounts.js'
import { initServices } from './bootstrap/services.js'
import { registerAllTools } from './bootstrap/tools.js'
import { initAIProviders } from './bootstrap/ai.js'
import { initPlugins, createConnectorReconnector } from './bootstrap/connectors.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main() {
  const config = await loadConfig()
  await ensureDefaultSkillPacks()

  // ---- Trading Accounts ----
  const { accountManager, accountSetups, ccxtInitPromise, initAccount } = await initTradingAccounts()

  // ---- Services (Brain, EventLog, Cron, OpenBB, SymbolIndex) ----
  const services = await initServices(config)
  const { brain, instructions, eventLog, cronEngine, newsStore, marketData } = services

  // ---- Tool Center ----
  const toolCenter = await registerAllTools({ config, accountManager, accountSetups, services, brain })

  // ---- AI Providers & Engine ----
  const { engine, backtest } = initAIProviders(config, toolCenter, instructions)

  // ---- Connector Center ----
  const connectorCenter = new ConnectorCenter(eventLog)

  // ---- Cron Lifecycle ----
  await cronEngine.start()
  const cronSession = new SessionStore('cron/default')
  await cronSession.restore()
  const cronListener = createCronListener({ connectorCenter, eventLog, engine, session: cronSession })
  cronListener.start()
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
  const { corePlugins, optionalPlugins } = initPlugins(config, toolCenter)

  // ---- Reconnect handlers ----
  const reconnectAccount = createAccountReconnector({ accountManager, accountSetups, initAccount, toolCenter })
  let ctx: EngineContext
  const reconnectConnectors = createConnectorReconnector(optionalPlugins, () => ctx)

  // ---- Engine Context ----
  ctx = {
    config, connectorCenter, engine, eventLog, heartbeat, cronEngine, toolCenter,
    accountManager, backtest, marketData,
    getAccountGit: (id) => accountSetups.get(id)?.git,
    reconnectAccount,
    reconnectConnectors,
    removeAccountSetup: (id) => { accountSetups.delete(id) },
  }

  for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
    await plugin.start(ctx)
    console.log(`plugin started: ${plugin.name}`)
  }

  console.log('engine: started')

  // ---- CCXT Background Injection ----
  ccxtInitPromise.then(() => {
    const hasCcxt = Array.from(accountSetups.values()).some(
      (s) => s.account instanceof CcxtAccount,
    )
    if (!hasCcxt) return
    toolCenter.register(
      createCcxtProviderTools({
        accountManager,
        getGit: (id) => accountSetups.get(id)?.git,
        getGitState: (id) => accountSetups.get(id)?.getGitState(),
      }),
      'trading-ccxt',
    )
    console.log('ccxt: provider tools registered')
  })

  // ---- Shutdown ----
  let stopped = false
  const shutdown = async () => {
    stopped = true
    newsCollector?.stop()
    heartbeat.stop()
    cronListener.stop()
    cronEngine.stop()
    for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
      await plugin.stop()
    }
    await newsStore.close()
    await eventLog.close()
    await accountManager.closeAll()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ---- Tick Loop ----
  while (!stopped) {
    await sleep(config.engine.interval)
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
