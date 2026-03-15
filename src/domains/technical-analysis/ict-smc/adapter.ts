import { tool } from 'ai'
import { z } from 'zod'
import type { OhlcvStore } from '@/domains/technical-analysis/indicator-kit/index'
import { analyzeIctSmc, type IctSmcAnalyzeOutputV2 } from './analyze'

const inputSchema = z.object({
  asset: z.literal('crypto'),
  symbol: z.string(),
  timeframe: z.string().optional(),
  lookbackBars: z.number().int().positive().optional(),
  recentBars: z.number().int().positive().optional(),
  swingLookback: z.number().int().min(1).max(10).optional(),
  detailLevel: z.enum(['core', 'full']).optional(),
  dropUnclosed: z.boolean().optional(),
})

export function createIctSmcTools(store: OhlcvStore) {
  return {
    ictSmcAnalyze: tool({
      description: `Aggregate deterministic ICT/SMC analysis (read-only).

Returns v2 output with two layers:
- core: stable decision fields
- detailed: full detection output for UI/debug (optional via detailLevel)`,
      inputSchema,
      execute: async (input): Promise<IctSmcAnalyzeOutputV2> => {
        const timeframe = input.timeframe ?? '5m'
        const lookbackBars = input.lookbackBars ?? 300
        const recentBars = input.recentBars ?? 10
        const swingLookback = input.swingLookback ?? 2

        const bars = await store.fetch({
          asset: input.asset,
          symbol: input.symbol,
          interval: timeframe,
          strategy: 'bars',
          lookbackBars,
          dropUnclosed: input.dropUnclosed,
        })

        const out = analyzeIctSmc({
          symbol: input.symbol,
          timeframe,
          lookbackBars,
          recentBars,
          swingLookback,
          bars,
        })

        if ((input.detailLevel ?? 'full') === 'core') {
          return {
            version: out.version,
            symbol: out.symbol,
            timeframe: out.timeframe,
            lookbackBars: out.lookbackBars,
            recentBars: out.recentBars,
            core: out.core,
          }
        }

        return out
      },
    }),
  }
}

export type { IctSmcAnalyzeOutputV2 as IctSmcAnalyzeOutput }
