import { tool } from 'ai'
import { z } from 'zod'
import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import type { BrooksPaAnalyzeOutput, Timeframes } from './types'
import {
  analyzeBrooksPa,
  buildBrooksLevels,
  detectBrooksStructure,
  loadBrooksContext,
  summarizeBrooksDecisionWindow,
} from './analyzer'
import { createMarketDataClients, getBarsForTimeframes } from './ohlcv'

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

async function loadInputData(input: z.infer<typeof inputSchema>, clients: ReturnType<typeof createMarketDataClients>) {
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
  const dataByTf = await getBarsForTimeframes({
    asset: input.asset,
    symbol: input.symbol,
    timeframes,
    lookbackBars,
    clients,
  })
  return { timeframes, lookbackBars, recentBars, midpointAvoidance, dataByTf }
}

export function createBrooksPaTools(
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
) {
  const clients = createMarketDataClients(equityClient, cryptoClient, currencyClient)

  return {
    brooksPaAnalyze: tool({
      description: `Deterministic Brooks-style price action analysis (read-only).

Returns a structured JSON summary across 3 timeframes (context/structure/execution).
Uses strict bars lookback (default 300) and only returns recentBars (default 10) for execution timeframe.`,
      inputSchema,
      execute: async (input): Promise<BrooksPaAnalyzeOutput> => {
        const { timeframes, lookbackBars, recentBars, midpointAvoidance, dataByTf } = await loadInputData(input, clients)
        return analyzeBrooksPa({
          symbol: input.symbol,
          timeframes,
          lookbackBars,
          recentBars,
          midpointAvoidance,
          dataByTf,
        })
      },
    }),
    brooksPaDetectStructure: tool({
      description: 'Detect deterministic Brooks-style trend, range, breakout, channel, wedge, and second-entry structure across configured timeframes.',
      inputSchema,
      execute: async (input) => {
        const { timeframes, dataByTf } = await loadInputData(input, clients)
        return detectBrooksStructure({ timeframes, dataByTf })
      },
    }),
    brooksPaBuildLevels: tool({
      description: 'Build deterministic Brooks support, resistance, and key bar levels across configured timeframes.',
      inputSchema,
      execute: async (input) => {
        const { timeframes, dataByTf } = await loadInputData(input, clients)
        return buildBrooksLevels({ timeframes, dataByTf })
      },
    }),
    brooksPaDecisionWindow: tool({
      description: 'Summarize the most recent Brooks decision window so the LLM only consumes recent bars plus structured notes.',
      inputSchema,
      execute: async (input) => {
        const { timeframes, lookbackBars, recentBars, midpointAvoidance, dataByTf } = await loadInputData(input, clients)
        const context = loadBrooksContext({
          symbol: input.symbol,
          timeframes,
          lookbackBars,
          recentBars,
          midpointAvoidance,
          dataByTf,
        })
        return summarizeBrooksDecisionWindow({
          tf: timeframes.execution,
          bars: context.dataByTf[timeframes.execution] ?? [],
          recentBars,
        })
      },
    }),
  }
}
