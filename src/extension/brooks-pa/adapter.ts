import { tool } from 'ai'
import { z } from 'zod'
import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import type { BrooksPaAnalyzeOutput, Timeframes } from './types'
import { analyzeBrooksPa } from './analyzer'
import { getBarsByTf } from './ohlcv'

const inputSchema = z.object({
  asset: z.enum(['equity', 'crypto', 'currency']),
  symbol: z.string(),
  timeframes: z.object({
    context: z.string().optional(),
    structure: z.string().optional(),
    execution: z.string().optional(),
  }).optional(),
  lookbackBars: z.number().int().positive().optional(),
  recentBars: z.number().int().positive().optional(),
  midpointAvoidance: z.object({
    enabled: z.boolean().optional(),
    band: z.number().min(0).max(0.5).optional(),
  }).optional(),
})

export function createBrooksPaTools(
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
) {
  return {
    brooksPaAnalyze: tool({
      description: `Deterministic Brooks-style price action analysis (read-only).

Returns a structured JSON summary across 3 timeframes (context/structure/execution).
Uses strict bars lookback (default 300) and only returns recentBars (default 10) for execution timeframe.`,
      inputSchema,
      execute: async (input): Promise<BrooksPaAnalyzeOutput> => {
        const timeframes: Timeframes = {
          context: input.timeframes?.context ?? '1h',
          structure: input.timeframes?.structure ?? '15m',
          execution: input.timeframes?.execution ?? '5m',
        }

        const lookbackBars = input.lookbackBars ?? 300
        const recentBars = input.recentBars ?? 10
        const midpointAvoidance = {
          enabled: input.midpointAvoidance?.enabled ?? true,
          band: input.midpointAvoidance?.band ?? 0.4,
        }

        const clients = { equityClient, cryptoClient, currencyClient }

        const [contextBars, structureBars, executionBars] = await Promise.all([
          getBarsByTf({ asset: input.asset, symbol: input.symbol, interval: timeframes.context, lookbackBars, clients }),
          getBarsByTf({ asset: input.asset, symbol: input.symbol, interval: timeframes.structure, lookbackBars, clients }),
          getBarsByTf({ asset: input.asset, symbol: input.symbol, interval: timeframes.execution, lookbackBars, clients }),
        ])

        return analyzeBrooksPa({
          symbol: input.symbol,
          timeframes,
          lookbackBars,
          recentBars,
          midpointAvoidance,
          dataByTf: {
            [timeframes.context]: contextBars,
            [timeframes.structure]: structureBars,
            [timeframes.execution]: executionBars,
          },
        })
      },
    }),
  }
}
