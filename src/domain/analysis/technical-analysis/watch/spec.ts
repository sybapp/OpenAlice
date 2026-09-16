/**
 * Issue `watch` declaration schema — the machine-checkable subset of a
 * monitoring Issue. Human intent stays in the markdown `What`; this is the
 * closed whitelist the deterministic checker understands.
 *
 * Named contexts let leaves select independent bar sources/intervals; the
 * required `source` is the backward-compatible `default`. Rules remain one-level
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

export const watchSourceSchema = z.object({
  barId: z.string().min(1),
  interval: watchIntervalSchema,
  assetClass: assetClassSchema.optional(),
}).strict()
export type WatchSource = z.infer<typeof watchSourceSchema>

export const watchSourceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, {
  message: 'source names must start with a lowercase letter and contain only lowercase letters, numbers, or hyphens',
})
export type WatchSourceName = z.infer<typeof watchSourceNameSchema>

function watchLeafObject<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, source: watchSourceNameSchema.optional() }).strict()
}

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

const priceAboveSchema = watchLeafObject({
  type: z.literal('price_above'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceBelowSchema = watchLeafObject({
  type: z.literal('price_below'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceInRangeSchema = watchLeafObject({
  type: z.literal('price_in_range'),
  low: z.number().finite(),
  high: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.low > value.high) {
    ctx.addIssue({ code: 'custom', path: ['low'], message: 'low must not exceed high' })
  }
})

const priceOutOfRangeSchema = watchLeafObject({
  type: z.literal('price_out_of_range'),
  low: z.number().finite(),
  high: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.low > value.high) {
    ctx.addIssue({ code: 'custom', path: ['low'], message: 'low must not exceed high' })
  }
})

const priceCrossAboveSchema = watchLeafObject({
  type: z.literal('price_cross_above'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceCrossBelowSchema = watchLeafObject({
  type: z.literal('price_cross_below'),
  price: z.number().finite(),
  field: closeFieldSchema.optional(),
}).strict()

const priceTouchSchema = watchLeafObject({
  type: z.literal('price_touch'),
  price: z.number().finite(),
  /** How many of the most recent closed bars may overlap the level (default 1). */
  lookbackBars: z.number().int().min(1).max(500).optional(),
}).strict()

const volumeSpikeSchema = watchLeafObject({
  type: z.literal('volume_spike'),
  /** Prior-bar window for the mean (default 20). */
  lookback: z.number().int().min(1).max(199).optional(),
  /** Last-bar volume must reach this multiple of the mean (default 2). */
  multiplier: z.number().finite().gt(1).optional(),
}).strict()

const cvdSlopeSchema = watchLeafObject({
  type: z.literal('cvd_slope'),
  direction: z.enum(['rising', 'falling']),
  /** CVD change window in bars (default 5). */
  lookback: z.number().int().min(1).max(199).optional(),
}).strict()

const priceVolumeDivergenceSchema = watchLeafObject({
  type: z.literal('price_volume_divergence'),
  kind: z.enum(['bullish', 'bearish']),
  /** Trailing window fed to the pivot/CVD detector (default 50). */
  lookback: z.number().int().min(1).max(199).optional(),
}).strict()

const emaAlignmentSchema = watchLeafObject({
  type: z.literal('ema_alignment'),
  direction: z.enum(['bullish', 'bearish']),
}).strict()

const priceVsEmaSchema = watchLeafObject({
  type: z.literal('price_vs_ema'),
  which: z.enum(['fast', 'slow', 'long']),
  relation: z.enum(['above', 'below']),
}).strict()

const priceVsVwapSchema = watchLeafObject({
  type: z.literal('price_vs_vwap'),
  relation: z.enum(['above', 'below', 'at']),
  anchor: z.enum(['auto', 'rolling', 'session', 'week', 'month', 'year', 'structure']).optional(),
}).strict()

const structureBreakSchema = watchLeafObject({
  type: z.literal('structure_break'),
  kind: z.enum(['BOS', 'CHoCH', 'any']),
  direction: z.enum(['bullish', 'bearish']).optional(),
  level: z.enum(['internal', 'swing', 'external']).optional(),
  /** Lower bound (bar-date string) for the break bar; older events are ignored. */
  since: z.string().min(1).optional(),
}).strict()

const zoneTouchSchema = watchLeafObject({
  type: z.literal('zone_touch'),
  zone: z.enum(['FVG', 'OB']),
  relation: z.literal('touch'),
  /** How many of the most recent closed bars may touch (default 1). */
  lookbackBars: z.number().int().min(1).max(500).optional(),
}).strict()

/** Closed leaf set. Anything else is a schema error, never a silent miss. */
export const watchLeafSchema = z.discriminatedUnion('type', [
  priceAboveSchema,
  priceBelowSchema,
  priceInRangeSchema,
  priceOutOfRangeSchema,
  priceCrossAboveSchema,
  priceCrossBelowSchema,
  priceTouchSchema,
  volumeSpikeSchema,
  cvdSlopeSchema,
  priceVolumeDivergenceSchema,
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
  volume_spike: 'price',
  cvd_slope: 'price',
  price_volume_divergence: 'price',
  ema_alignment: 'indicators',
  price_vs_ema: 'indicators',
  price_vs_vwap: 'indicators',
  structure_break: 'priceAction',
  zone_touch: 'priceAction',
} satisfies Record<WatchLeafType, WatchLeafDataKind>

/** `auto` / `structure` VWAP asks the price-action layer for its anchor. */
export function needsPriceAction(leaf: WatchLeaf): boolean {
  return watchLeafDataKind[leaf.type] === 'priceAction'
    || (leaf.type === 'price_vs_vwap'
      && (leaf.anchor === undefined || leaf.anchor === 'auto' || leaf.anchor === 'structure'))
}

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

export const WATCH_MAX_CONTEXTS = 5
export const WATCH_MAX_NAMED_SOURCES = WATCH_MAX_CONTEXTS - 1

/** The required source is always the default context. */
export function watchContexts(watch: Pick<IssueWatch, 'source' | 'sources'>): Record<string, WatchSource> {
  return { default: watch.source, ...watch.sources }
}

export const issueWatchSchema = z.object({
  version: z.number().int().min(1),
  source: watchSourceSchema,
  /** Additional named contexts. The required `source` field remains `default`. */
  sources: z.record(watchSourceNameSchema, watchSourceSchema).optional(),
  /** Omission means closed-bar quote. */
  quote: watchQuoteSchema.optional(),
  freshness: watchFreshnessSchema.optional(),
  /** Indicator tuning for the checker's computation (defaults apply). */
  indicators: technicalAnalysisIndicatorOptionsSchema.optional(),
  rule: watchRuleSchema,
}).strict().superRefine((value, ctx) => {
  if (value.sources?.default !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['sources', 'default'], message: 'default is reserved for source' })
  }
  if (Object.keys(value.sources ?? {}).length > WATCH_MAX_NAMED_SOURCES) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: `at most ${WATCH_MAX_NAMED_SOURCES} named sources are allowed` })
  }
  for (const [name, source] of Object.entries(value.sources ?? {})) {
    if (source.barId === value.source.barId && source.interval === value.source.interval) {
      ctx.addIssue({ code: 'custom', path: ['sources', name], message: 'named source must differ from default source' })
    }
  }
  const sources = watchContexts(value)
  for (const leaf of watchLeaves(value.rule)) {
    const sourceName = leaf.source ?? 'default'
    const source = sources[sourceName]
    if (source === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rule'], message: `leaf references unknown source: ${sourceName}` })
      continue
    }
    const isIntraday = source.interval !== '1d' && source.interval !== '1w'
    if (isIntraday && leaf.type === 'price_touch' && value.freshness?.maxStaleMinutes === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['freshness', 'maxStaleMinutes'],
        message: 'intraday price_touch requires freshness.maxStaleMinutes',
      })
    }
  }
})
export type IssueWatch = z.infer<typeof issueWatchSchema>
