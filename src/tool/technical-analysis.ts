/**
 * Unified technical-analysis tool.
 *
 * The tool is deliberately a thin schema adapter. Price Action, order-flow
 * aggregation, and indicator/confluence calculations live in the domain
 * module so the agent sees one coherent analysis contract instead of several
 * partially overlapping tools.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { analyzeTechnicalAnalysis } from '@/domain/analysis/technical-analysis/context.js'
import { technicalAnalysisIndicatorOptionsSchema } from '@/domain/analysis/technical-analysis/indicators.js'
import { priceActionOptionsSchema } from '@/domain/analysis/technical-analysis/price-action/context.js'
import type { BarService } from '@/domain/market-data/bars/index.js'

export interface TechnicalAnalysisToolsDeps {
  barService: BarService
}

const assetClassSchema = z.enum(['equity', 'crypto', 'currency', 'commodity'])
const technicalAnalysisInputSchema = z.object({
  barId: z.string().describe('Bar source ID from search-bars'),
  assetClass: assetClassSchema.optional()
    .describe('Required only for compatibility vendor barIds; native and broker sources infer routing'),
  interval: z.string().optional()
    .describe('One target interval, for example 15m, 1h, 4h, or 1d'),
  intervals: z.array(z.string()).min(1).max(8).optional()
    .describe('Optional higher-timeframe-to-execution interval list; runs sequentially'),
  count: z.number().int().positive().optional().describe('Bars per interval (default 200)'),
  start: z.string().optional().describe('Start date (YYYY-MM-DD)'),
  end: z.string().optional().describe('End date (YYYY-MM-DD)'),
  mode: z.enum(['context', 'execution', 'debug']).optional()
    .describe('context: compact read; execution: volume-confirmed price action; debug: include raw order-flow views'),
  indicators: technicalAnalysisIndicatorOptionsSchema.optional(),
  priceAction: priceActionOptionsSchema.optional()
    .describe('Optional Price Action detector tuning; mode supplies the default preset'),
  numBins: z.number().int().positive().optional().describe('Volume Profile bin count (default 20)'),
}).strict().superRefine((input, ctx) => {
  if (!input.interval && !input.intervals?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide interval or intervals' })
  }
})

export function createTechnicalAnalysisTools(deps: TechnicalAnalysisToolsDeps) {
  return {
    analyzeTechnicalAnalysis: tool({
      description: `Run the unified technical-analysis read for one or more K-line intervals.

This is the single agent-facing entrypoint for market structure, ICT/SMC Price
Action, approximate OHLCV-derived order flow, and classic technical indicators.
The response keeps those signals in one interval-scoped result:

- Price Action: FVG/VI/OG, iFVG, order blocks, BOS/CHoCH, liquidity pools and sweeps,
  breakers, premium/discount, and structure state.
- Order Flow: approximate delta/CVD, Volume Profile, POC/value area, divergence,
  absorption, and exhaustion. Its fidelity is bar_proxy, not tick/order-book data;
  inspect coverage, confidence, and degradation metadata.
- Indicators: EMA bias, anchored VWAP relation, structure-leg Fibonacci retracements,
  and EMA/VWAP/Fibonacci confluence zones.

Use intervals for a compact multi-timeframe read. Intervals run sequentially and
the top-level summary reports bias, alignment, conflicts, and confluences. The
debug mode includes raw delta bars and profile bins; normal context is compact.

Find a source with search-bars first, and prefer the broker barId that matches
the position when one is available.`,
      inputSchema: technicalAnalysisInputSchema,
      execute: async (input) => analyzeTechnicalAnalysis(deps.barService, input),
    }),
  }
}
