/**
 * Issue `watch` declaration schema — the machine-checkable subset of a
 * monitoring Issue. Human intent stays in the markdown `What`; this is the
 * closed whitelist the deterministic checker understands.
 *
 * v1 is deliberately small: one source + one interval per watch, one-level
 * `all` / `any` (1–8 leaves), closed-bar quote only. Unknown `type` or extra
 * keys are invalid (loud), never a silent miss.
 *
 * This module is pure schema + types (no IO, no bar fetching). The evaluator
 * lives in `./eval.js`, freshness/closed-bar gates in `./freshness.js`.
 */

import { z } from 'zod'

import { technicalAnalysisIndicatorOptionsSchema } from '../indicators.js'

/** Mirror of the bar-layer interval set (kept local so this schema has no
 * runtime dependency on the bar service). Must stay in sync with
 * `SUPPORTED_BAR_INTERVALS` in `domain/market-data/bars/types.ts`. */
export const watchIntervalSchema = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])
export type WatchInterval = z.infer<typeof watchIntervalSchema>

const assetClassSchema = z.enum(['equity', 'crypto', 'currency', 'commodity'])

const watchSourceSchema = z.object({
  barId: z.string().min(1),
  interval: watchIntervalSchema,
  assetClass: assetClassSchema.optional(),
}).strict()

/** v1 quote is closed bars only. An intraday "touch" must explicitly declare
 * a realtime/quote source once that kind exists; close price never proves an
 * intraday touch, so no other kind validates today. */
const watchQuoteSchema = z.object({
  kind: z.literal('closed_bar'),
}).strict()

const watchFreshnessSchema = z.object({
  /** Max tolerated trading-day gap between the last bar and the anchor.
   * Omission means 0 (data must reach the anchor day). */
  maxStaleTradingDays: z.number().int().min(0).max(30).optional(),
  /** Max tolerated wall-clock gap (minutes) between the last closed bar end
   * and now, for intraday intervals. Omission means no minute-level bound. */
  maxStaleMinutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
}).strict()

const closeFieldSchema = z.literal('close')

const priceAboveSchema = z.object({
  type: z.literal('price_above'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceBelowSchema = z.object({
  type: z.literal('price_below'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceInRangeSchema = z.object({
  type: z.literal('price_in_range'),
  low: z.number().finite(),
  high: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.low > value.high) {
    ctx.addIssue({ code: 'custom', path: ['low'], message: 'low must not exceed high' })
  }
})

const priceOutOfRangeSchema = z.object({
  type: z.literal('price_out_of_range'),
  low: z.number().finite(),
  high: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.low > value.high) {
    ctx.addIssue({ code: 'custom', path: ['low'], message: 'low must not exceed high' })
  }
})

const priceCrossAboveSchema = z.object({
  type: z.literal('price_cross_above'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceCrossBelowSchema = z.object({
  type: z.literal('price_cross_below'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceTouchSchema = z.object({
  type: z.literal('price_touch'),
  price: z.number().finite(),
  /** How many of the most recent closed bars may overlap the level (default 1). */
  lookbackBars: z.number().int().min(1).max(500).optional(),
}).strict()

const emaAlignmentSchema = z.object({
  type: z.literal('ema_alignment'),
  direction: z.enum(['bullish', 'bearish']),
}).strict()

const priceVsEmaSchema = z.object({
  type: z.literal('price_vs_ema'),
  which: z.enum(['fast', 'slow', 'long']),
  relation: z.enum(['above', 'below']),
}).strict()

const priceVsVwapSchema = z.object({
  type: z.literal('price_vs_vwap'),
  relation: z.enum(['above', 'below', 'at']),
  anchor: z.enum(['auto', 'rolling', 'session', 'week', 'month', 'year', 'structure']).optional(),
}).strict()

const structureBreakSchema = z.object({
  type: z.literal('structure_break'),
  kind: z.enum(['BOS', 'CHoCH', 'any']),
  direction: z.enum(['bullish', 'bearish']).optional(),
  level: z.enum(['internal', 'swing', 'external']).optional(),
  /** Lower bound (bar-date string) for the break bar; older events are ignored. */
  since: z.string().min(1).optional(),
}).strict()

const zoneTouchSchema = z.object({
  type: z.literal('zone_touch'),
  zone: z.enum(['FVG', 'OB']),
  relation: z.literal('touch'),
  /** How many of the most recent closed bars may touch (default 1). */
  lookbackBars: z.number().int().min(1).max(500).optional(),
}).strict()

/** Closed v1 leaf set. Anything else is a schema error, never a silent miss. */
export const watchLeafSchema = z.discriminatedUnion('type', [
  priceAboveSchema,
  priceBelowSchema,
  priceInRangeSchema,
  priceOutOfRangeSchema,
  priceCrossAboveSchema,
  priceCrossBelowSchema,
  priceTouchSchema,
  emaAlignmentSchema,
  priceVsEmaSchema,
  priceVsVwapSchema,
  structureBreakSchema,
  zoneTouchSchema,
])
export type WatchLeaf = z.infer<typeof watchLeafSchema>
export type WatchLeafType = WatchLeaf['type']
export type WatchLeafDataKind = 'price' | 'indicators' | 'priceAction'

/** Every leaf must declare its computation dependency. The Record is an
 * exhaustiveness check: adding a schema leaf without classifying it fails the
 * typecheck instead of silently returning `unavailable`. `price_vs_vwap` has
 * a price-action exception for auto/structure anchors in the checker. */
export const watchLeafDataKind = {
  price_above: 'price',
  price_below: 'price',
  price_in_range: 'price',
  price_out_of_range: 'price',
  price_cross_above: 'price',
  price_cross_below: 'price',
  price_touch: 'price',
  ema_alignment: 'indicators',
  price_vs_ema: 'indicators',
  price_vs_vwap: 'indicators',
  structure_break: 'priceAction',
  zone_touch: 'priceAction',
} satisfies Record<WatchLeafType, WatchLeafDataKind>

const watchAllSchema = z.object({
  all: z.array(watchLeafSchema).min(1).max(8),
}).strict()

const watchAnySchema = z.object({
  any: z.array(watchLeafSchema).min(1).max(8),
}).strict()

/** One level only: a single leaf, or one `all` / `any` group. No nesting. */
export const watchRuleSchema = z.union([watchLeafSchema, watchAllSchema, watchAnySchema])
export type WatchRule = z.infer<typeof watchRuleSchema>

export function watchLeaves(rule: WatchRule): WatchLeaf[] {
  if ('all' in rule) return rule.all
  if ('any' in rule) return rule.any
  return [rule]
}

export const issueWatchSchema = z.object({
  version: z.number().int().min(1),
  source: watchSourceSchema,
  /** Omission means closed-bar quote. */
  quote: watchQuoteSchema.optional(),
  freshness: watchFreshnessSchema.optional(),
  /** Indicator tuning for the checker's computation (defaults apply). */
  indicators: technicalAnalysisIndicatorOptionsSchema.optional(),
  rule: watchRuleSchema,
}).strict().superRefine((value, ctx) => {
  const isIntraday = value.source.interval !== '1d' && value.source.interval !== '1w'
  if (isIntraday && watchLeaves(value.rule).some((leaf) => leaf.type === 'price_touch')
    && value.freshness?.maxStaleMinutes === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['freshness', 'maxStaleMinutes'],
      message: 'intraday price_touch requires freshness.maxStaleMinutes',
    })
  }
})
export type IssueWatch = z.infer<typeof issueWatchSchema>
