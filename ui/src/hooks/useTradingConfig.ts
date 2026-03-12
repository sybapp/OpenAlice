import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type {
  PlatformConfig,
  TradingConfigAccount,
  UpdateTradingAccountRequest,
  ReconnectResult,
} from '../api/types'

export interface UseTradingConfigResult {
  platforms: PlatformConfig[]
  accounts: TradingConfigAccount[]
  loading: boolean
  error: string | null

  savePlatform: (p: PlatformConfig) => Promise<void>
  deletePlatform: (id: string) => Promise<void>
  saveAccount: (a: UpdateTradingAccountRequest) => Promise<TradingConfigAccount>
  deleteAccount: (id: string) => Promise<void>
  reconnectAccount: (id: string) => Promise<ReconnectResult>
  refresh: () => Promise<void>
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items, next]
  const updated = [...items]
  updated[index] = next
  return updated
}

export function useTradingConfig(): UseTradingConfigResult {
  const [platforms, setPlatforms] = useState<PlatformConfig[]>([])
  const [accounts, setAccounts] = useState<TradingConfigAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await api.trading.loadTradingConfig()
      setPlatforms(data.platforms)
      setAccounts(data.accounts)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const savePlatform = useCallback(async (p: PlatformConfig) => {
    await api.trading.upsertPlatform(p)
    setPlatforms((prev) => upsertById(prev, p))
  }, [])

  const deletePlatform = useCallback(async (id: string) => {
    await api.trading.deletePlatform(id)
    setPlatforms((prev) => prev.filter((p) => p.id !== id))
  }, [])

  const saveAccount = useCallback(async (a: UpdateTradingAccountRequest) => {
    const saved = await api.trading.upsertAccount(a)
    setAccounts((prev) => upsertById(prev, saved))
    return saved
  }, [])

  const deleteAccount = useCallback(async (id: string) => {
    await api.trading.deleteAccount(id)
    setAccounts((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const reconnectAccount = useCallback(async (id: string): Promise<ReconnectResult> => {
    return api.trading.reconnectAccount(id)
  }, [])

  return {
    platforms, accounts, loading, error,
    savePlatform, deletePlatform,
    saveAccount, deleteAccount,
    reconnectAccount, refresh: load,
  }
}
