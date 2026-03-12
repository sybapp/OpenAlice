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
import { VercelAIProvider } from '../ai-providers/vercel-ai-sdk/vercel-provider.js'
import { ClaudeCodeProvider } from '../ai-providers/claude-code/claude-code-provider.js'
import { CodexCliProvider } from '../ai-providers/codex-cli/index.js'
import { createBacktestStorage, createBacktestRunManager } from '../extension/trading/index.js'
import type { BacktestRunManager } from '../extension/trading/index.js'

export interface AIResult {
  engine: Engine
  agentCenter: AgentCenter
  router: ProviderRouter
  backtest: BacktestRunManager
}

export function initAIProviders(config: Config, toolCenter: ToolCenter, instructions: string): AIResult {
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
  const engine = new Engine({ agentCenter })

  const backtestStorage = createBacktestStorage()
  const backtest = createBacktestRunManager({ storage: backtestStorage, engine })

  return { engine, agentCenter, router, backtest }
}
