/**
 * Bootstrap: Tools
 *
 * Registers all tools into the ToolCenter.
 */

import type { Config } from '../core/config.js'
import { ToolCenter } from '../core/tool-center.js'
import { createThinkingTools } from '../extension/cognition/thinking-kit/index.js'
import { createBrainTools } from '../extension/cognition/brain/index.js'
import { createTradingTools } from '../extension/trading/index.js'
import type { AccountManager, AccountSetup } from '../extension/trading/index.js'
import { createEquityTools } from '../extension/research/equity/index.js'
import { createMarketSearchTools } from '../extension/research/market/index.js'
import { createNewsTools } from '../extension/research/news/index.js'
import { createIndicatorTools } from '../extension/technical-analysis/indicator-tools/index.js'
import { createBrooksPaTools } from '../extension/technical-analysis/brooks-pa/index.js'
import { createIctSmcTools } from '../extension/technical-analysis/ict-smc/index.js'
import { createCronTools } from '../task/cron/index.js'
import { wrapNewsToolsForPiggyback, createNewsArchiveTools } from '../extension/research/news-collector/index.js'
import { listSkillPacks } from '../core/skills/registry.js'
import { validateSkillToolReferences } from '../core/skills/policy.js'
import type { Brain } from '../extension/cognition/brain/index.js'
import type { initServices } from './services.js'

type Services = Awaited<ReturnType<typeof initServices>>

export async function registerAllTools(deps: {
  config: Config
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
  services: Services
  brain: Brain
}) {
  const { config, accountManager, accountSetups, services, brain } = deps
  const {
    cronEngine, equityClient, cryptoClient, currencyClient,
    newsClient, newsStore, symbolIndex, providers,
    ohlcvStore,
  } = services

  const toolCenter = new ToolCenter()
  toolCenter.register(createThinkingTools(), 'thinking')

  toolCenter.register(
    createTradingTools({
      accountManager,
      getGit: (id) => accountSetups.get(id)?.git,
      getGitState: (id) => accountSetups.get(id)?.getGitState(),
    }),
    'trading',
  )

  toolCenter.register(createBrainTools(brain), 'brain')
  toolCenter.register(createCronTools(cronEngine), 'cron')
  toolCenter.register(createMarketSearchTools(symbolIndex, cryptoClient, currencyClient), 'market-search')
  toolCenter.register(createEquityTools(equityClient), 'equity')

  let newsTools = createNewsTools(newsClient, {
    companyProvider: providers.newsCompany,
    worldProvider: providers.newsWorld,
  })
  if (config.newsCollector.piggybackOpenBB) {
    newsTools = wrapNewsToolsForPiggyback(newsTools, newsStore)
  }
  toolCenter.register(newsTools, 'news')
  if (config.newsCollector.enabled) {
    toolCenter.register(createNewsArchiveTools(newsStore), 'news-archive')
  }

  toolCenter.register(createIndicatorTools(ohlcvStore), 'analysis')
  toolCenter.register(createBrooksPaTools(ohlcvStore), 'analysis')
  toolCenter.register(createIctSmcTools(ohlcvStore), 'analysis')

  for (const skill of await listSkillPacks()) {
    for (const warning of validateSkillToolReferences(skill, toolCenter.getInventory())) {
      console.warn(warning)
    }
  }

  console.log(`tool-center: ${toolCenter.list().length} tools registered`)
  return toolCenter
}
