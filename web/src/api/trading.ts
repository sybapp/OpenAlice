import { fetchApi, fetchJson, fetchJsonOrThrow, fetchOkOrThrow, headers } from './client'
import type {
  TradingAccount,
  AccountInfo,
  Position,
  TradingCommitLog,
  ReconnectResult,
  PlatformConfig,
  TradingConfigAccount,
  UpdateTradingAccountRequest,
} from './types'

function tradingAccountPath(accountId: string, suffix: string): string {
  return `/api/trading/accounts/${accountId}/${suffix}`
}

// ==================== Unified Trading API ====================

export const tradingApi = {
  // ==================== Accounts ====================

  async listAccounts(): Promise<{ accounts: TradingAccount[] }> {
    return fetchJson('/api/trading/accounts')
  },

  async equity(): Promise<{ totalEquity: number; totalCash: number; totalUnrealizedPnL: number; totalRealizedPnL: number; accounts: Array<{ id: string; label: string; equity: number; cash: number }> }> {
    return fetchJson('/api/trading/equity')
  },

  // ==================== Per-account ====================

  async reconnectAccount(accountId: string): Promise<ReconnectResult> {
    const res = await fetchApi(tradingAccountPath(accountId, 'reconnect'), { method: 'POST' })
    return res.json()
  },

  async accountInfo(accountId: string): Promise<AccountInfo> {
    return fetchJson(tradingAccountPath(accountId, 'account'))
  },

  async positions(accountId: string): Promise<{ positions: Position[] }> {
    return fetchJson(tradingAccountPath(accountId, 'positions'))
  },

  async orders(accountId: string): Promise<{ orders: unknown[] }> {
    return fetchJson(tradingAccountPath(accountId, 'orders'))
  },

  async marketClock(accountId: string): Promise<{ isOpen: boolean; nextOpen: string; nextClose: string }> {
    return fetchJson(tradingAccountPath(accountId, 'market-clock'))
  },

  async tradingLog(accountId: string, limit = 20, symbol?: string): Promise<{ commits: TradingCommitLog[] }> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (symbol) params.set('symbol', symbol)
    return fetchJson(`${tradingAccountPath(accountId, 'trading/log')}?${params}`)
  },

  async tradingShow(accountId: string, hash: string): Promise<unknown> {
    return fetchJson(tradingAccountPath(accountId, `trading/show/${hash}`))
  },

  async tradingStatus(accountId: string): Promise<unknown> {
    return fetchJson(tradingAccountPath(accountId, 'trading/status'))
  },

  // ==================== Trading Config CRUD ====================

  async loadTradingConfig(): Promise<{ platforms: PlatformConfig[]; accounts: TradingConfigAccount[] }> {
    return fetchJson('/api/trading/config')
  },

  async upsertPlatform(platform: PlatformConfig): Promise<PlatformConfig> {
    return fetchJsonOrThrow(`/api/trading/config/platforms/${platform.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(platform),
    }, 'Failed to save platform')
  },

  async deletePlatform(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/trading/config/platforms/${id}`, { method: 'DELETE' }, 'Failed to delete platform')
  },

  async upsertAccount(account: UpdateTradingAccountRequest): Promise<TradingConfigAccount> {
    return fetchJsonOrThrow(`/api/trading/config/accounts/${account.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(account),
    }, 'Failed to save account')
  },

  async deleteAccount(id: string): Promise<void> {
    await fetchOkOrThrow(`/api/trading/config/accounts/${id}`, { method: 'DELETE' }, 'Failed to delete account')
  },
}
