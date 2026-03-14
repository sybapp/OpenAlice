import { tool } from 'ai'
import { z } from 'zod'
import type { Timeframes } from './types'
import { analyzeBrooksPa } from './analyzer'
import { buildBrooksCoreFromDetailed, type BrooksPaAnalyzeOutputV2 } from './analyzer/core'
import type { OhlcvStore } from '@/domains/technical-analysis/indicator-kit/index'

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
  detailLevel: z.enum(['core', 'full']).optional(),
  dropUnclosed: z.boolean().optional(),
})

export function createBrooksPaTools(store: OhlcvStore) {
  return {
    brooksPaAnalyze: tool({
      description: `Deterministic Brooks-style price action analysis (read-only).

Returns v2 output with two layers:
- core: stable fields for trading decisions / programmatic use
- detailed: full deterministic breakdown for UI/debug (optional via detailLevel)

Uses strict bars lookback (default 300) and recentBars (default 10) for execution timeframe.`,
      inputSchema,
      execute: async (input): Promise<BrooksPaAnalyzeOutputV2> => {
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

        const [ctxBars, strBars, exeBars] = await Promise.all([
          store.fetch({
            asset: input.asset,
            symbol: input.symbol,
            interval: timeframes.context,
            strategy: 'bars',
            lookbackBars,
            dropUnclosed: input.dropUnclosed,
          }),
          store.fetch({
            asset: input.asset,
            symbol: input.symbol,
            interval: timeframes.structure,
            strategy: 'bars',
            lookbackBars,
            dropUnclosed: input.dropUnclosed,
          }),
          store.fetch({
            asset: input.asset,
            symbol: input.symbol,
            interval: timeframes.execution,
            strategy: 'bars',
            lookbackBars,
            dropUnclosed: input.dropUnclosed,
          }),
        ])

        const detailed = analyzeBrooksPa({
          symbol: input.symbol,
          timeframes,
          lookbackBars,
          recentBars,
          midpointAvoidance,
          dataByTf: {
            [timeframes.context]: ctxBars,
            [timeframes.structure]: strBars,
            [timeframes.execution]: exeBars,
          },
        })

        const core = buildBrooksCoreFromDetailed(detailed, { symbol: input.symbol, timeframes })

        const base = {
          version: 2 as const,
          symbol: input.symbol,
          timeframes,
          lookbackBars,
          recentBars,
          core,
        }

        if ((input.detailLevel ?? 'full') === 'core') return base

        return {
          ...base,
          detailed,
        }
      },
    }),
  }
}

export type { BrooksPaAnalyzeOutputV2 as BrooksPaAnalyzeOutput }
