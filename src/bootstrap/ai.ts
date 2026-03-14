/**
 * Bootstrap: AI Providers
 *
 * VercelAIProvider, ClaudeCodeProvider, CodexCliProvider, ProviderRouter,
 * AgentCenter, Engine, and backtest run manager.
 */

import type { Config } from '../core/config.js'
import type { ToolCenter } from '../core/tool-center.js'
import { Engine } from '../core/engine.js'
import { AgentCenter } from '../core/agent-center.js'
import { ProviderRouter } from '../core/ai-provider.js'
import { createLocalCommandRouter } from '../core/commands/router.js'
import { SkillLoopRunner } from '../core/skills/skill-loop.js'
import { VercelAIProvider } from '../ai-providers/vercel-ai-sdk/vercel-provider.js'
import { ClaudeCodeProvider } from '../ai-providers/claude-code/claude-code-provider.js'
import { CodexCliProvider } from '../ai-providers/codex-cli/index.js'
import { createBacktestStorage, createBacktestRunManager } from '../extension/trading/index.js'
import type { AccountManager, BacktestRunManager } from '../extension/trading/index.js'
import type { Brain } from '../extension/cognition/brain/index.js'
import type { EventLog } from '../core/event-log.js'
import type { ITradingGit } from '../extension/trading/index.js'
import type { MarketDataBridge } from '../core/types.js'
import type { SymbolIndex } from '../openbb/equity/index.js'
import type {
  CryptoClientLike,
  CurrencyClientLike,
  EquityClientLike,
  NewsClientLike,
} from '../openbb/sdk/index.js'
import type { INewsProvider } from '../extension/research/news-collector/index.js'
import type { OhlcvStore } from '../extension/technical-analysis/indicator-kit/index.js'

export interface AIResult {
  engine: Engine
  agentCenter: AgentCenter
  router: ProviderRouter
  backtest: BacktestRunManager
}

export interface SkillRuntimeDeps {
  brain: Brain
  eventLog: EventLog
  accountManager: AccountManager
  marketData: MarketDataBridge
  symbolIndex: SymbolIndex
  ohlcvStore: OhlcvStore
  equityClient: EquityClientLike
  cryptoClient: CryptoClientLike
  currencyClient: CurrencyClientLike
  newsClient: NewsClientLike
  newsStore: INewsProvider
  getAccountGit: (accountId: string) => ITradingGit | undefined
}

export function initAIProviders(
  config: Config,
  toolCenter: ToolCenter,
  instructions: string,
  skillRuntime: SkillRuntimeDeps,
): AIResult {
  const vercelProvider = new VercelAIProvider(
    (policy) => toolCenter.getVercelTools(policy),
    instructions,
    config.agent.maxSteps,
    config.compaction,
  )
  const claudeCodeProvider = new ClaudeCodeProvider(config.compaction, instructions)
  const codexCliProvider = new CodexCliProvider(config.compaction, instructions)
  const router = new ProviderRouter(vercelProvider, claudeCodeProvider, codexCliProvider)

  const agentCenter = new AgentCenter(router)
  const engine = new Engine({
    agentCenter,
    commandRouter: createLocalCommandRouter(),
    skillLoopRunner: new SkillLoopRunner(agentCenter, {
      config,
      brain: skillRuntime.brain,
      eventLog: skillRuntime.eventLog,
      accountManager: skillRuntime.accountManager,
      marketData: skillRuntime.marketData,
      symbolIndex: skillRuntime.symbolIndex,
      ohlcvStore: skillRuntime.ohlcvStore,
      equityClient: skillRuntime.equityClient,
      cryptoClient: skillRuntime.cryptoClient,
      currencyClient: skillRuntime.currencyClient,
      newsClient: skillRuntime.newsClient,
      newsStore: skillRuntime.newsStore,
      getAccountGit: skillRuntime.getAccountGit,
      invocation: {},
    }),
  })

  const backtestStorage = createBacktestStorage()
  const backtest = createBacktestRunManager({ storage: backtestStorage, engine })

  return { engine, agentCenter, router, backtest }
}
