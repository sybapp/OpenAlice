/**
 * Trading Statistics
 *
 * Computes performance metrics from git commit history.
 */

import type { GitCommit, OperationResult } from './git/types.js'

export interface TradingStatsResult {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  totalPnL: number
  maxDrawdown: number
  bySymbol: Record<string, { trades: number; pnl: number }>
}

export function computeTradingStats(commits: GitCommit[]): TradingStatsResult {
  const trades: Array<{ symbol: string; pnl: number }> = []

  for (const commit of commits) {
    for (let i = 0; i < commit.operations.length; i++) {
      const op = commit.operations[i]
      const result = commit.results[i]
      if (!result?.success) continue
      if (result.status !== 'filled') continue

      if (op.action === 'closePosition') {
        const symbol = op.params.symbol ?? 'unknown'
        // Estimate PnL from state changes — use realizedPnL delta if available
        // For close operations, look at the result's filled info
        if (result.filledPrice != null && result.filledQty != null) {
          // We need entry price to compute PnL — scan previous commits for the position
          const entryPrice = findEntryPrice(commits, commit, symbol)
          if (entryPrice != null) {
            const pnl = (result.filledPrice - entryPrice) * result.filledQty
            trades.push({ symbol, pnl })
          }
        }
      }

      // Also capture sync fills that close positions (realizedPnLDelta)
      if (op.action === 'syncOrders' && result.filledPrice != null) {
        // Sync results with realized PnL are tracked via OrderStatusUpdate
        // We can extract from the commit's stateAfter vs parent
      }
    }
  }

  // Also extract from equity curve for drawdown
  const equityCurve = commits
    .filter((c) => c.stateAfter)
    .map((c) => c.stateAfter.equity)

  // Compute from realized PnL deltas between consecutive commits
  const realizedPnLs: number[] = []
  for (let i = 1; i < commits.length; i++) {
    const prev = commits[i - 1].stateAfter.realizedPnL
    const curr = commits[i].stateAfter.realizedPnL
    const delta = curr - prev
    if (delta !== 0) {
      // Find the symbol from the commit's operations
      const sym = extractSymbolFromCommit(commits[i])
      realizedPnLs.push(delta)
      // Only add if not already captured from closePosition
      if (!trades.some((t) => t.pnl === delta && t.symbol === sym)) {
        trades.push({ symbol: sym, pnl: delta })
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)

  const totalWin = wins.reduce((s, t) => s + t.pnl, 0)
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))

  const bySymbol: Record<string, { trades: number; pnl: number }> = {}
  for (const trade of trades) {
    const entry = bySymbol[trade.symbol] ?? { trades: 0, pnl: 0 }
    entry.trades += 1
    entry.pnl += trade.pnl
    bySymbol[trade.symbol] = entry
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgWin: wins.length > 0 ? totalWin / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLoss / losses.length : 0,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0,
    totalPnL: totalWin - totalLoss,
    maxDrawdown: computeMaxDrawdown(equityCurve),
    bySymbol,
  }
}

function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0
  let peak = equityCurve[0]
  let maxDd = 0
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDd) maxDd = dd
  }
  return maxDd
}

function findEntryPrice(
  commits: GitCommit[],
  beforeCommit: GitCommit,
  symbol: string,
): number | undefined {
  // Walk backwards through commits to find the most recent placeOrder fill for this symbol
  for (let i = commits.indexOf(beforeCommit) - 1; i >= 0; i--) {
    const c = commits[i]
    for (let j = 0; j < c.operations.length; j++) {
      const op = c.operations[j]
      const result = c.results[j]
      if (
        op.action === 'placeOrder' &&
        op.params.symbol === symbol &&
        result?.status === 'filled' &&
        result.filledPrice != null
      ) {
        return result.filledPrice
      }
    }
  }
  return undefined
}

function extractSymbolFromCommit(commit: GitCommit): string {
  for (const op of commit.operations) {
    if (op.action === 'placeOrder' || op.action === 'closePosition') {
      return op.params.symbol ?? 'unknown'
    }
  }
  return 'unknown'
}
