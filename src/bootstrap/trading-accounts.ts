/**
 * Bootstrap: Trading Accounts (continued)
 *
 * Account initialization and reconnect logic.
 */

import { loadTradingConfig } from '../core/config.js'
import type { ReconnectResult } from '../core/types.js'
import {
  AccountManager,
  CcxtAccount,
  createCcxtProviderTools,
  wireAccountTrading,
  createPlatformFromConfig,
  createAccountFromConfig,
  validatePlatformRefs,
} from '../extension/trading/index.js'
import type { AccountSetup, IPlatform } from '../extension/trading/index.js'
import type { ToolCenter } from '../core/tool-center.js'
import { gitFilePath, gitArchivePath, loadGitState, createGitPersister } from './trading.js'

export interface TradingAccountsResult {
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
  ccxtInitPromise: Promise<void>
  initAccount: (
    accountCfg: { id: string; platformId: string; guards: Array<{ type: string; options: Record<string, unknown> }> },
    platform: IPlatform,
  ) => Promise<boolean>
}

export async function initTradingAccounts(): Promise<TradingAccountsResult> {
  const accountManager = new AccountManager()
  const accountSetups = new Map<string, AccountSetup>()

  const tradingConfig = await loadTradingConfig()
  const platformRegistry = new Map<string, IPlatform>()
  for (const pc of tradingConfig.platforms) {
    platformRegistry.set(pc.id, createPlatformFromConfig(pc))
  }
  validatePlatformRefs([...platformRegistry.values()], tradingConfig.accounts)

  async function initAccount(
    accountCfg: { id: string; platformId: string; guards: Array<{ type: string; options: Record<string, unknown> }> },
    platform: IPlatform,
  ): Promise<boolean> {
    const account = createAccountFromConfig(platform, accountCfg)
    try {
      await account.init()
    } catch (err) {
      console.warn(`trading: ${accountCfg.id} init failed (non-fatal):`, err)
      return false
    }
    const savedState = await loadGitState(accountCfg.id)
    const filePath = gitFilePath(accountCfg.id)
    const setup = wireAccountTrading(account, {
      guards: accountCfg.guards,
      savedState,
      onCommit: createGitPersister(filePath),
      archivePath: gitArchivePath(accountCfg.id),
    })
    accountManager.addAccount(account, accountCfg.platformId)
    accountSetups.set(account.id, setup)
    console.log(`trading: ${account.label} initialized`)
    return true
  }

  const ccxtAccountConfigs: Array<{ cfg: typeof tradingConfig.accounts[number]; platform: IPlatform }> = []

  for (const accCfg of tradingConfig.accounts) {
    const platform = platformRegistry.get(accCfg.platformId)!
    if (platform.providerType === 'alpaca') {
      await initAccount(accCfg, platform)
    } else {
      ccxtAccountConfigs.push({ cfg: accCfg, platform })
    }
  }

  const ccxtInitPromise = ccxtAccountConfigs.length > 0
    ? (async () => {
        for (const { cfg, platform } of ccxtAccountConfigs) {
          await initAccount(cfg, platform)
        }
      })()
    : Promise.resolve()

  return { accountManager, accountSetups, ccxtInitPromise, initAccount }
}

export function createAccountReconnector(deps: {
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
  initAccount: TradingAccountsResult['initAccount']
  toolCenter: ToolCenter
}): (accountId: string) => Promise<ReconnectResult> {
  const { accountManager, accountSetups, initAccount, toolCenter } = deps
  const reconnecting = new Set<string>()

  return async (accountId: string): Promise<ReconnectResult> => {
    if (reconnecting.has(accountId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    reconnecting.add(accountId)
    try {
      const freshTrading = await loadTradingConfig()

      const currentAccount = accountManager.getAccount(accountId)
      if (currentAccount) {
        await currentAccount.close()
        accountManager.removeAccount(accountId)
        accountSetups.delete(accountId)
      }

      const accCfg = freshTrading.accounts.find((a) => a.id === accountId)
      if (!accCfg) {
        return { success: true, message: `Account "${accountId}" not found in config (removed or disabled)` }
      }

      const freshPlatforms = new Map<string, IPlatform>()
      for (const pc of freshTrading.platforms) {
        freshPlatforms.set(pc.id, createPlatformFromConfig(pc))
      }

      const platform = freshPlatforms.get(accCfg.platformId)
      if (!platform) {
        return { success: false, error: `Platform "${accCfg.platformId}" not found for account "${accountId}"` }
      }

      const ok = await initAccount(accCfg, platform)
      if (!ok) {
        return { success: false, error: `Account "${accountId}" init failed` }
      }

      if (platform.providerType !== 'alpaca') {
        toolCenter.register(
          createCcxtProviderTools({
            accountManager,
            getGit: (id) => accountSetups.get(id)?.git,
            getGitState: (id) => accountSetups.get(id)?.getGitState(),
          }),
          'trading-ccxt',
        )
      }

      const label = accountManager.getAccount(accountId)?.label ?? accountId
      console.log(`reconnect: ${label} online`)
      return { success: true, message: `${label} reconnected` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`reconnect: ${accountId} failed:`, msg)
      return { success: false, error: msg }
    } finally {
      reconnecting.delete(accountId)
    }
  }
}
