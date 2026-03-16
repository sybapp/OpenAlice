/**
 * Bootstrap: Trading Accounts (continued)
 *
 * Account initialization and reconnect logic.
 */

import { loadTradingConfig, type PlatformConfig } from '../core/config.js'
import type { ReconnectResult } from '../core/types.js'
import {
  AccountManager,
  wireAccountTrading,
  createPlatformFromConfig,
  createAccountFromConfig,
  validatePlatformRefs,
} from '../domains/trading/index.js'
import type { AccountSetup, IPlatform } from '../domains/trading/index.js'
import { gitFilePath, gitArchivePath, loadGitState, createGitPersister } from './trading.js'

type TradingAccountConfig = {
  id: string
  platformId: string
  guards: Array<{ type: string; options: Record<string, unknown> }>
}

interface PreparedAccountRuntime {
  account: Awaited<ReturnType<typeof createAccountFromConfig>>
  setup: AccountSetup
}

export interface TradingAccountsResult {
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
  ccxtInitPromise: Promise<void>
  prepareAccountRuntime: (accountCfg: TradingAccountConfig, platform: IPlatform) => Promise<PreparedAccountRuntime | null>
  initAccount: (accountCfg: TradingAccountConfig, platform: IPlatform) => Promise<boolean>
}

function buildPlatformRegistry(platforms: PlatformConfig[]): Map<string, IPlatform> {
  const registry = new Map<string, IPlatform>()
  for (const platform of platforms) {
    registry.set(platform.id, createPlatformFromConfig(platform))
  }
  return registry
}

export async function initTradingAccounts(): Promise<TradingAccountsResult> {
  const accountManager = new AccountManager()
  const accountSetups = new Map<string, AccountSetup>()

  const tradingConfig = await loadTradingConfig()
  const platformRegistry = buildPlatformRegistry(tradingConfig.platforms)
  validatePlatformRefs([...platformRegistry.values()], tradingConfig.accounts)

  async function prepareAccountRuntime(
    accountCfg: TradingAccountConfig,
    platform: IPlatform,
  ): Promise<PreparedAccountRuntime | null> {
    const account = createAccountFromConfig(platform, accountCfg)
    try {
      await account.init()
    } catch (err) {
      console.warn(`trading: ${accountCfg.id} init failed (non-fatal):`, err)
      return null
    }
    const savedState = await loadGitState(accountCfg.id)
    const filePath = gitFilePath(accountCfg.id)
    const setup = wireAccountTrading(account, {
      guards: accountCfg.guards,
      savedState,
      onCommit: createGitPersister(filePath),
      archivePath: gitArchivePath(accountCfg.id),
    })
    return { account, setup }
  }

  async function initAccount(
    accountCfg: TradingAccountConfig,
    platform: IPlatform,
  ): Promise<boolean> {
    const prepared = await prepareAccountRuntime(accountCfg, platform)
    if (!prepared) {
      return false
    }
    const { account, setup } = prepared
    accountManager.addAccount(account, accountCfg.platformId)
    accountSetups.set(account.id, setup)
    console.log(`trading: ${account.label} initialized`)
    return true
  }

  for (const accCfg of tradingConfig.accounts) {
    const platform = platformRegistry.get(accCfg.platformId)!
    await initAccount(accCfg, platform)
  }

  const ccxtInitPromise = Promise.resolve()

  return { accountManager, accountSetups, ccxtInitPromise, prepareAccountRuntime, initAccount }
}

export async function teardownAccountRuntime(args: {
  accountId: string
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
}): Promise<void> {
  const { accountId, accountManager, accountSetups } = args
  const setup = accountSetups.get(accountId)
  setup?.disposeDispatcher()

  const currentAccount = accountManager.getAccount(accountId)
  if (currentAccount) {
    await currentAccount.close()
  }

  accountManager.removeAccount(accountId)
  accountSetups.delete(accountId)
}

export function createAccountReconnector(deps: {
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
  prepareAccountRuntime: TradingAccountsResult['prepareAccountRuntime']
}): (accountId: string) => Promise<ReconnectResult> {
  const { accountManager, accountSetups, prepareAccountRuntime } = deps
  const reconnecting = new Set<string>()

  return async (accountId: string): Promise<ReconnectResult> => {
    if (reconnecting.has(accountId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    reconnecting.add(accountId)
    try {
      const freshTrading = await loadTradingConfig()

      const accCfg = freshTrading.accounts.find((a) => a.id === accountId)
      if (!accCfg) {
        await teardownAccountRuntime({ accountId, accountManager, accountSetups })
        return { success: true, message: `Account "${accountId}" not found in config (removed or disabled)` }
      }

      const freshPlatforms = buildPlatformRegistry(freshTrading.platforms)

      const platform = freshPlatforms.get(accCfg.platformId)
      if (!platform) {
        return { success: false, error: `Platform "${accCfg.platformId}" not found for account "${accountId}"` }
      }

      const prepared = await prepareAccountRuntime(accCfg, platform)
      if (!prepared) {
        return { success: false, error: `Account "${accountId}" init failed` }
      }

      try {
        await teardownAccountRuntime({ accountId, accountManager, accountSetups })
        accountManager.addAccount(prepared.account, accCfg.platformId)
        accountSetups.set(prepared.account.id, prepared.setup)
      } catch (err) {
        prepared.setup.disposeDispatcher()
        await prepared.account.close().catch(() => undefined)
        throw err
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
