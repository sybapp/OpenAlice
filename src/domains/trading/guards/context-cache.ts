/**
 * Guard Context Cache
 *
 * Caches positions and account info within a short TTL window so that
 * multiple guard checks in the same push cycle share a single API call.
 */

import type { ITradingAccount, Position, AccountInfo } from '../interfaces.js'

export interface GuardContextCacheOptions {
  /** Cache TTL in milliseconds. Default: 2000 */
  ttlMs?: number
}

export class GuardContextCache {
  private readonly account: ITradingAccount
  private readonly ttlMs: number

  private positionsCache?: { data: Position[]; ts: number }
  private accountCache?: { data: AccountInfo; ts: number }

  constructor(account: ITradingAccount, options?: GuardContextCacheOptions) {
    this.account = account
    this.ttlMs = options?.ttlMs ?? 2000
  }

  async getPositions(): Promise<Position[]> {
    const now = Date.now()
    if (this.positionsCache && now - this.positionsCache.ts < this.ttlMs) {
      return this.positionsCache.data
    }
    const data = await this.account.getPositions()
    this.positionsCache = { data, ts: Date.now() }
    return data
  }

  async getAccount(): Promise<AccountInfo> {
    const now = Date.now()
    if (this.accountCache && now - this.accountCache.ts < this.ttlMs) {
      return this.accountCache.data
    }
    const data = await this.account.getAccount()
    this.accountCache = { data, ts: Date.now() }
    return data
  }

  invalidate(): void {
    this.positionsCache = undefined
    this.accountCache = undefined
  }
}
