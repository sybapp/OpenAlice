import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTradingTools } from './adapter.js'
import { MockTradingAccount, makeOrder, makePosition } from './__test__/mock-account.js'
import type { GitState, OrderStatusUpdate } from './git/types.js'

const emptyState: GitState = {
  cash: 0,
  equity: 0,
  unrealizedPnL: 0,
  realizedPnL: 0,
  positions: [],
  pendingOrders: [],
}

function createHarness(params: {
  pendingOrders: Array<{ orderId: string; symbol: string }>
}) {
  const account = new MockTradingAccount({
    capabilities: {
      supportedSecTypes: ['CRYPTO'],
      supportedOrderTypes: ['market', 'limit', 'stop', 'stop_limit', 'take_profit'],
    },
  })

  const git = {
    getPendingOrderIds: vi.fn(() => params.pendingOrders),
    sync: vi.fn(async (updates: OrderStatusUpdate[], state: GitState) => ({
      hash: 'sync-hash',
      updatedCount: updates.length,
      updates,
      state,
    })),
  }

  const accountManager = {
    listAccounts: () => [{
      id: account.id,
      provider: account.provider,
      label: account.label,
      capabilities: account.getCapabilities(),
    }],
    getAccount: (id: string) => (id === account.id ? account : undefined),
  }

  const tools = createTradingTools({
    accountManager: accountManager as any,
    getGit: (accountId: string) => (accountId === account.id ? (git as any) : undefined),
    getGitState: (accountId: string) => (accountId === account.id ? Promise.resolve(emptyState) : undefined),
  })

  return { account, git, tools }
}

describe('createTradingTools tradingSync orphan cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cancels orphan reduceOnly protection orders when there is no position', async () => {
    const { account, git, tools } = createHarness({ pendingOrders: [] })

    account.setOrders([
      makeOrder({
        id: 'tp-orphan',
        contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
        side: 'sell',
        type: 'take_profit',
        qty: 0.1,
        reduceOnly: true,
        status: 'pending',
        filledPrice: undefined,
        filledQty: undefined,
      }),
    ])
    account.setPositions([])
    account.cancelOrder.mockResolvedValue(true)

    const result = await (tools.tradingSync as { execute: (args: { source: string }) => Promise<Record<string, unknown>> }).execute({
      source: account.id,
    })

    expect(account.cancelOrder).toHaveBeenCalledWith('tp-orphan')
    expect(result).toMatchObject({ updatedCount: 0, orphanCancelled: 1 })
    expect(git.sync).not.toHaveBeenCalled()
  })

  it('marks missing tracked pending orders as cancelled when symbol has no position', async () => {
    const { account, git, tools } = createHarness({
      pendingOrders: [{ orderId: 'old-pending', symbol: 'BTCUSDT' }],
    })

    account.setOrders([])
    account.setPositions([])

    await (tools.tradingSync as { execute: (args: { source: string }) => Promise<Record<string, unknown>> }).execute({
      source: account.id,
    })

    expect(git.sync).toHaveBeenCalledTimes(1)
    const [updates] = git.sync.mock.calls[0] as [OrderStatusUpdate[], GitState]
    expect(updates).toMatchObject([
      {
        orderId: 'old-pending',
        symbol: 'BTCUSDT',
        previousStatus: 'pending',
        currentStatus: 'cancelled',
      },
    ])
  })

  it('does not cancel protection orders when position still exists', async () => {
    const { account, tools } = createHarness({ pendingOrders: [] })

    account.setOrders([
      makeOrder({
        id: 'tp-active',
        contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
        side: 'sell',
        type: 'take_profit',
        qty: 0.1,
        reduceOnly: true,
        status: 'pending',
        filledPrice: undefined,
        filledQty: undefined,
      }),
    ])
    account.setPositions([
      makePosition({
        contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
        qty: 0.1,
        avgEntryPrice: 65000,
        currentPrice: 65100,
        marketValue: 6510,
        costBasis: 6500,
      }),
    ])

    const result = await (tools.tradingSync as { execute: (args: { source: string }) => Promise<Record<string, unknown>> }).execute({
      source: account.id,
    })

    expect(account.cancelOrder).not.toHaveBeenCalled()
    expect(result).toMatchObject({ message: 'No pending orders to sync.', updatedCount: 0 })
  })
})
