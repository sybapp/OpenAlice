/**
 * Market Search AI Tool
 *
 * marketSearchForResearch:
 *   统一的市场数据 symbol 搜索入口（crypto only）。
 */

import { tool } from 'ai'
import { z } from 'zod'

interface CryptoClientLike {
  search(params: Record<string, unknown>): Promise<Record<string, unknown>[]>
}

export function createMarketSearchTools(
  cryptoClient: CryptoClientLike,
) {
  return {
    marketSearchForResearch: tool({
      description: `Search crypto symbols for market data research.

If unsure about the symbol, use this to find the correct one for market data tools
(calculateIndicator, structure analysis, etc.).
This is NOT for trading — use searchContracts to find broker-tradeable contracts.`,
      inputSchema: z.object({
        query: z.string().describe('Keyword to search, e.g. "bitcoin", "ETH", "SOL"'),
        limit: z.number().int().positive().optional().describe('Max results (default: 20)'),
      }),
      execute: async ({ query, limit }) => {
        const cap = limit ?? 20
        const cryptoResults = (await cryptoClient.search({ query }).catch(() => []))
          .slice(0, cap)
          .map((r) => ({
          ...r,
          assetClass: 'crypto' as const,
        }))
        const results = cryptoResults
        if (results.length === 0) {
          return { results: [], message: `No symbols matching "${query}". Try a different keyword.` }
        }
        return { results, count: results.length }
      },
    }),
  }
}
