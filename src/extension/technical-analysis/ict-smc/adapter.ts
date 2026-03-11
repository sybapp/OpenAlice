import { tool } from 'ai'
import { z } from 'zod'
import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import { createMarketDataClients, getBarsByTf } from '@/extension/technical-analysis/brooks-pa/ohlcv'
import { detectFairValueGaps } from './analyzer/fvg'
import { detectLiquidityPools } from './analyzer/liquidity'
import { detectBosChoch, detectStructure, summarizeIctDecisionWindow } from './analyzer/structure'
import { detectSwings } from './analyzer/swings'
import type { IctSmcAnalyzeOutput } from './types'

const inputSchema = z.object({
  asset: z.enum(['equity', 'crypto', 'currency']),
  symbol: z.string(),
  timeframe: z.string().optional(),
  lookbackBars: z.number().int().positive().optional(),
  recentBars: z.number().int().positive().optional(),
  swingLookback: z.number().int().min(1).max(10).optional(),
})

async function loadBars(params: {
  asset: 'equity' | 'crypto' | 'currency'
  symbol: string
  timeframe: string
  lookbackBars: number
  equityClient: OpenBBEquityClient
  cryptoClient: OpenBBCryptoClient
  currencyClient: OpenBBCurrencyClient
}) {
  return await getBarsByTf({
    asset: params.asset,
    symbol: params.symbol,
    interval: params.timeframe,
    lookbackBars: params.lookbackBars,
    clients: createMarketDataClients(params.equityClient, params.cryptoClient, params.currencyClient),
  })
}

export function createIctSmcTools(
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
) {
  return {
    ictSmcDetectSwings: tool({
      description: 'Detect deterministic ICT/SMC swing highs and swing lows from OHLCV.',
      inputSchema,
      execute: async (input) => {
        const bars = await loadBars({
          asset: input.asset,
          symbol: input.symbol,
          timeframe: input.timeframe ?? '5m',
          lookbackBars: input.lookbackBars ?? 300,
          equityClient,
          cryptoClient,
          currencyClient,
        })
        return detectSwings(bars, input.swingLookback ?? 2)
      },
    }),
    ictSmcDetectLiquidity: tool({
      description: 'Detect deterministic ICT/SMC liquidity pools such as equal highs and equal lows.',
      inputSchema,
      execute: async (input) => {
        const bars = await loadBars({
          asset: input.asset,
          symbol: input.symbol,
          timeframe: input.timeframe ?? '5m',
          lookbackBars: input.lookbackBars ?? 300,
          equityClient,
          cryptoClient,
          currencyClient,
        })
        const swings = detectSwings(bars, input.swingLookback ?? 2)
        return detectLiquidityPools(swings, bars)
      },
    }),
    ictSmcDetectFvg: tool({
      description: 'Detect deterministic ICT/SMC fair value gaps and whether they have been filled.',
      inputSchema,
      execute: async (input) => {
        const bars = await loadBars({
          asset: input.asset,
          symbol: input.symbol,
          timeframe: input.timeframe ?? '5m',
          lookbackBars: input.lookbackBars ?? 300,
          equityClient,
          cryptoClient,
          currencyClient,
        })
        return detectFairValueGaps(bars)
      },
    }),
    ictSmcDetectStructure: tool({
      description: 'Detect deterministic ICT/SMC BOS, CHOCH, displacement, mitigation, and premium-discount state.',
      inputSchema,
      execute: async (input) => {
        const bars = await loadBars({
          asset: input.asset,
          symbol: input.symbol,
          timeframe: input.timeframe ?? '5m',
          lookbackBars: input.lookbackBars ?? 300,
          equityClient,
          cryptoClient,
          currencyClient,
        })
        const swings = detectSwings(bars, input.swingLookback ?? 2)
        const liquidity = detectLiquidityPools(swings, bars)
        const fvgs = detectFairValueGaps(bars)
        return detectStructure({ swings, bars, fvgs, liquidity })
      },
    }),
    ictSmcAnalyze: tool({
      description: 'Aggregate deterministic ICT/SMC structure analysis and return only structured outputs plus the recent decision window.',
      inputSchema,
      execute: async (input): Promise<IctSmcAnalyzeOutput> => {
        const timeframe = input.timeframe ?? '5m'
        const lookbackBars = input.lookbackBars ?? 300
        const recentBars = input.recentBars ?? 10
        const swingLookback = input.swingLookback ?? 2
        const bars = await loadBars({
          asset: input.asset,
          symbol: input.symbol,
          timeframe,
          lookbackBars,
          equityClient,
          cryptoClient,
          currencyClient,
        })
        const swings = detectSwings(bars, swingLookback)
        const liquidity = detectLiquidityPools(swings, bars)
        const fvgs = detectFairValueGaps(bars)
        const bosChoch = detectBosChoch(swings, bars)
        const structure = detectStructure({ swings, bars, fvgs, liquidity })
        const decisionWindow = summarizeIctDecisionWindow({
          tf: timeframe,
          bars: bars.slice(-recentBars),
          liquidity,
          structure,
        })
        return {
          symbol: input.symbol,
          timeframe,
          lookbackBars,
          recentBars,
          swings,
          liquidity,
          fvgs,
          structure: {
            ...structure,
            bos: bosChoch.bos,
            choch: bosChoch.choch,
            latestSwingHigh: bosChoch.latestSwingHigh,
            latestSwingLow: bosChoch.latestSwingLow,
            bias: bosChoch.bias,
          },
          decisionWindow,
        }
      },
    }),
  }
}
