/**
 * AI tool factories for CCXT exchanges.
 *
 * Registered dynamically when a CCXT account comes online.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { resolveAccounts } from '../../adapter.js'
import type { AccountResolver } from '../../adapter.js'
import { CcxtAccount } from './CcxtAccount.js'

export function createCcxtProviderTools(resolver: AccountResolver) {
  const { accountManager } = resolver

  /** Resolve to exactly one CcxtAccount. Returns error object if unable. */
  const resolveCcxtOne = (source?: string): { account: CcxtAccount; id: string } | { error: string } => {
    const targets = resolveAccounts(accountManager, source)
      .filter((t): t is { account: CcxtAccount; id: string } => t.account instanceof CcxtAccount)
    if (targets.length === 0) return { error: 'No CCXT account available.' }
    if (targets.length > 1) {
      return { error: `Multiple CCXT accounts: ${targets.map(t => t.id).join(', ')}. Specify source.` }
    }
    return targets[0]
  }

  const sourceDesc =
    'Account source — matches account id or provider name. Auto-resolves if only one CCXT account exists.'

  return {
    getFundingRate: tool({
      description: `Query the current funding rate for a perpetual contract.

Returns:
- fundingRate: current/latest funding rate (e.g. 0.0001 = 0.01%)
- nextFundingTime: when the next funding payment occurs
- previousFundingRate: the previous period's rate

Positive rate = longs pay shorts. Negative rate = shorts pay longs.
Use searchContracts first to get the aliceId.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts (e.g. "bybit-BTCUSDT")'),
        source: z.string().optional().describe(sourceDesc),
      }),
      execute: async ({ aliceId, source }) => {
        const resolved = resolveCcxtOne(source)
        if ('error' in resolved) return resolved
        const { account, id } = resolved
        const result = await account.getFundingRate({ aliceId })
        return { source: id, ...result }
      },
    }),

    getOrderBook: tool({
      description: `Query the order book (market depth) for a contract.

Returns bids and asks sorted by price. Each level is [price, amount].
Use this to evaluate liquidity and potential slippage before placing large orders.
Use searchContracts first to get the aliceId.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts (e.g. "bybit-BTCUSDT")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Number of price levels per side (default: 20)'),
        source: z.string().optional().describe(sourceDesc),
      }),
      execute: async ({ aliceId, limit, source }) => {
        const resolved = resolveCcxtOne(source)
        if ('error' in resolved) return resolved
        const { account, id } = resolved
        const result = await account.getOrderBook({ aliceId }, limit ?? 20)
        return { source: id, ...result }
      },
    }),

    setStopLoss: tool({
      description: `Stage a native stop-loss order for an existing CCXT position.

Behavior:
- Looks up the current position to determine side and default size
- Stages a reduce-only stop order on the opposite side
- Protects the full position by default; pass qty for partial protection

Use this after opening a futures position when you want exchange-native downside protection.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts or getPortfolio (e.g. "bybit-BTCUSDT")'),
        stopPrice: z.number().positive().describe('Trigger price for the stop-loss order'),
        qty: z.number().positive().optional().describe('Quantity to protect (default: full current position)'),
        source: z.string().optional().describe(sourceDesc),
      }),
      execute: async ({ aliceId, stopPrice, qty, source }) => {
        const resolved = resolveCcxtOne(source)
        if ('error' in resolved) return resolved
        const { account, id } = resolved

        const position = (await account.getPositions()).find((p) => p.contract.aliceId === aliceId)
        if (!position) return { error: `No open position for ${aliceId}.` }

        const git = resolver.getGit(id)
        if (!git) return { error: `No git instance for account "${id}".` }

        return git.add({
          action: 'placeOrder',
          params: {
            aliceId: position.contract.aliceId,
            symbol: position.contract.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            type: 'stop',
            qty: qty ?? position.qty,
            stopPrice,
            reduceOnly: true,
            timeInForce: 'gtc',
          },
        })
      },
    }),

    setTakeProfit: tool({
      description: `Stage a native take-profit order for an existing CCXT position.

Behavior:
- Looks up the current position to determine side and default size
- Stages a reduce-only take-profit order on the opposite side
- Protects the full position by default; pass qty for partial profit taking

Use this after opening a futures position when you want an exchange-native upside target.`,
      inputSchema: z.object({
        aliceId: z.string().describe('Contract identifier from searchContracts or getPortfolio (e.g. "bybit-BTCUSDT")'),
        takeProfitPrice: z.number().positive().describe('Trigger price for the take-profit order'),
        qty: z.number().positive().optional().describe('Quantity to protect (default: full current position)'),
        source: z.string().optional().describe(sourceDesc),
      }),
      execute: async ({ aliceId, takeProfitPrice, qty, source }) => {
        const resolved = resolveCcxtOne(source)
        if ('error' in resolved) return resolved
        const { account, id } = resolved

        const position = (await account.getPositions()).find((p) => p.contract.aliceId === aliceId)
        if (!position) return { error: `No open position for ${aliceId}.` }

        const git = resolver.getGit(id)
        if (!git) return { error: `No git instance for account "${id}".` }

        return git.add({
          action: 'placeOrder',
          params: {
            aliceId: position.contract.aliceId,
            symbol: position.contract.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            type: 'take_profit',
            qty: qty ?? position.qty,
            stopPrice: takeProfitPrice,
            reduceOnly: true,
            timeInForce: 'gtc',
          },
        })
      },
    }),

  }
}
