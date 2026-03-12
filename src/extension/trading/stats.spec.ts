import { describe, it, expect } from 'vitest'
import { computeTradingStats } from './stats.js'
import type { GitCommit } from './git/types.js'

function makeCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    hash: 'abcd1234',
    parentHash: null,
    message: 'test',
    operations: [],
    results: [],
    stateAfter: {
      cash: 100_000,
      equity: 100_000,
      unrealizedPnL: 0,
      realizedPnL: 0,
      positions: [],
      pendingOrders: [],
    },
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('computeTradingStats', () => {
  it('returns zeros for empty commits', () => {
    const result = computeTradingStats([])
    expect(result.totalTrades).toBe(0)
    expect(result.winRate).toBe(0)
    expect(result.maxDrawdown).toBe(0)
  })

  it('computes stats from realized PnL deltas', () => {
    const commits: GitCommit[] = [
      makeCommit({
        hash: 'a1',
        stateAfter: { cash: 100_000, equity: 100_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] },
        operations: [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }],
        results: [{ action: 'placeOrder', success: true, status: 'filled', filledPrice: 100, filledQty: 10 }],
      }),
      makeCommit({
        hash: 'a2',
        parentHash: 'a1',
        stateAfter: { cash: 101_500, equity: 101_500, unrealizedPnL: 0, realizedPnL: 500, positions: [], pendingOrders: [] },
        operations: [{ action: 'closePosition', params: { symbol: 'AAPL' } }],
        results: [{ action: 'closePosition', success: true, status: 'filled', filledPrice: 150, filledQty: 10 }],
      }),
      makeCommit({
        hash: 'a3',
        parentHash: 'a2',
        stateAfter: { cash: 101_300, equity: 101_300, unrealizedPnL: 0, realizedPnL: 300, positions: [], pendingOrders: [] },
        operations: [{ action: 'closePosition', params: { symbol: 'GOOG' } }],
        results: [{ action: 'closePosition', success: true, status: 'filled', filledPrice: 90, filledQty: 5 }],
      }),
    ]

    const result = computeTradingStats(commits)
    expect(result.totalTrades).toBeGreaterThanOrEqual(2)
    expect(result.wins).toBeGreaterThanOrEqual(1)
    expect(result.losses).toBeGreaterThanOrEqual(1)
    expect(result.winRate).toBeGreaterThan(0)
    expect(result.winRate).toBeLessThan(1)
  })

  it('computes maxDrawdown from equity curve', () => {
    const commits: GitCommit[] = [
      makeCommit({ hash: 'b1', stateAfter: { cash: 100_000, equity: 100_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] } }),
      makeCommit({ hash: 'b2', stateAfter: { cash: 100_000, equity: 110_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] } }),
      makeCommit({ hash: 'b3', stateAfter: { cash: 100_000, equity: 95_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] } }),
      makeCommit({ hash: 'b4', stateAfter: { cash: 100_000, equity: 105_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] } }),
    ]

    const result = computeTradingStats(commits)
    // Peak was 110k, trough was 95k → drawdown = 15k
    expect(result.maxDrawdown).toBe(15_000)
  })

  it('tracks per-symbol breakdown', () => {
    const commits: GitCommit[] = [
      makeCommit({
        hash: 'c1',
        stateAfter: { cash: 100_000, equity: 100_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] },
        operations: [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }],
        results: [{ action: 'placeOrder', success: true, status: 'filled', filledPrice: 100, filledQty: 10 }],
      }),
      makeCommit({
        hash: 'c2',
        parentHash: 'c1',
        stateAfter: { cash: 100_500, equity: 100_500, unrealizedPnL: 0, realizedPnL: 500, positions: [], pendingOrders: [] },
        operations: [{ action: 'closePosition', params: { symbol: 'AAPL' } }],
        results: [{ action: 'closePosition', success: true, status: 'filled', filledPrice: 150, filledQty: 10 }],
      }),
    ]

    const result = computeTradingStats(commits)
    expect(result.bySymbol['AAPL']).toBeDefined()
    expect(result.bySymbol['AAPL'].pnl).toBeGreaterThan(0)
  })

  it('profitFactor is Infinity when no losses', () => {
    const commits: GitCommit[] = [
      makeCommit({
        hash: 'd1',
        stateAfter: { cash: 100_000, equity: 100_000, unrealizedPnL: 0, realizedPnL: 0, positions: [], pendingOrders: [] },
      }),
      makeCommit({
        hash: 'd2',
        parentHash: 'd1',
        stateAfter: { cash: 100_500, equity: 100_500, unrealizedPnL: 0, realizedPnL: 500, positions: [], pendingOrders: [] },
        operations: [{ action: 'closePosition', params: { symbol: 'AAPL' } }],
        results: [{ action: 'closePosition', success: true, status: 'filled', filledPrice: 150, filledQty: 10 }],
      }),
    ]

    const result = computeTradingStats(commits)
    expect(result.profitFactor).toBe(Infinity)
  })
})
