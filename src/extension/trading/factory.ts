/**
 * Trading Account Factory
 *
 * Wires an ITradingAccount with TradingGit, guards, and operation dispatcher.
 * Also provides config-to-account creation helpers.
 */

import type { ITradingAccount } from './interfaces.js'
import type { ITradingGit } from './git/interfaces.js'
import type { GitExportState, GitState } from './git/types.js'
import { TradingGit } from './git/TradingGit.js'
import { createOperationDispatcher } from './operation-dispatcher.js'
import { createWalletStateBridge } from './wallet-state-bridge.js'
import { createGuardPipeline, resolveGuards } from './guards/index.js'
import { AlpacaAccount } from './providers/alpaca/index.js'
import { CcxtAccount } from './providers/ccxt/index.js'
import type { Config } from '../../core/config.js'

// ==================== AccountSetup ====================

export interface AccountSetup {
  account: ITradingAccount
  git: ITradingGit
  getGitState: () => Promise<GitState>
}

// ==================== Wiring ====================

/**
 * Wire an ITradingAccount with TradingGit + guards + dispatcher.
 * Does NOT call account.init() — caller is responsible for lifecycle.
 */
export function wireAccountTrading(
  account: ITradingAccount,
  options: {
    guards?: Array<{ type: string; options?: Record<string, unknown> }>
    savedState?: GitExportState
    onCommit?: (state: GitExportState) => void | Promise<void>
    archivePath?: string
    maxActiveCommits?: number
  },
): AccountSetup {
  const getGitState = createWalletStateBridge(account)
  const dispatcher = createOperationDispatcher(account)
  const guards = resolveGuards(options.guards ?? [])
  const guardedDispatcher = createGuardPipeline(dispatcher, account, guards)

  const gitConfig = {
    executeOperation: guardedDispatcher,
    getGitState,
    onCommit: options.onCommit,
    archivePath: options.archivePath,
    maxActiveCommits: options.maxActiveCommits,
  }

  const git = options.savedState
    ? TradingGit.restore(options.savedState, gitConfig)
    : new TradingGit(gitConfig)

  return { account, git, getGitState }
}

// ==================== Config → Account helpers ====================

/**
 * Create an AlpacaAccount from securities config section.
 * Returns null if provider type is 'none'.
 */
export function createAlpacaFromConfig(
  config: Config['securities'],
): AlpacaAccount | null {
  if (config.provider.type === 'none') return null
  const { apiKey, secretKey, paper } = config.provider
  return new AlpacaAccount({
    apiKey: apiKey ?? '',
    secretKey: secretKey ?? '',
    paper,
  })
}

/**
 * Create a CcxtAccount from crypto config section.
 * Returns null if provider type is 'none'.
 */
export function createCcxtFromConfig(
  config: Config['crypto'],
): CcxtAccount | null {
  if (config.provider.type === 'none') return null
  const p = config.provider
  return new CcxtAccount({
    exchange: p.exchange,
    apiKey: p.apiKey ?? '',
    apiSecret: p.apiSecret ?? '',
    password: p.password,
    sandbox: p.sandbox,
    demoTrading: p.demoTrading,
    defaultMarketType: p.defaultMarketType,
    options: p.options,
  })
}
