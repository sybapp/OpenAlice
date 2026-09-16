/**
 * `watch` check orchestration — fetch → freshness/closed-bar gate →
 * selective compute → pure evaluation. This is the internal seam the
 * scanner will call (increment 2); the scanner owns latch/state/dispatch,
 * this module owns one judgement over live data.
 *
 * Cost control: one `getBars` per check (the scanner shares per-tick
 * duplicates), indicator fib/confluence forced off (unused by the verdict),
 * and the order-flow path (`analyzeTechnicalAnalysisInterval`) never runs —
 * only `analyzePriceActionBars` + `buildTechnicalAnalysisIndicators` on the
 * loaded closed bars.
 *
 * Error contract: a `getBars` throw becomes `unavailable` (never a miss, so
 * a dead source cannot silently read as "condition false"). Compute errors
 * propagate — they are deterministic bugs the replay specs must catch, and
 * the scanner isolates per-issue check failures.
 */

import type {
  BarSourceRef,
  BarMeta,
  BarService,
  OhlcvBar,
} from '../../../market-data/bars/types.js'
import { analyzePriceActionBars, createEmptyMarketStructure } from '../price-action/analyze.js'
import { buildTechnicalAnalysisIndicators } from '../indicators.js'
import { evaluateWatch, type WatchEvaluationEvidence, type WatchLeafEvaluation } from './eval.js'
import { gateWatchFreshness } from './freshness.js'
import { watchLeafDataKind, watchLeaves, type IssueWatch } from './spec.js'

/** Bars loaded per check. Covers the ATR-200 default, EMA-50 default, and
 * the external-structure 101-bar window with headroom. */
export const WATCH_CHECK_BARS = 200

export interface WatchCheckDeps {
  barService: Pick<BarService, 'getBars'>
}

export interface WatchCheckVerdict {
  status: 'hit' | 'miss' | 'unavailable'
  leaves: WatchLeafEvaluation[]
  signalIds: string[]
  evidence: WatchEvaluationEvidence & { watchVersion: number; dataAsOf?: string }
  reason?: string
}

export async function checkWatch(
  deps: WatchCheckDeps,
  watch: IssueWatch,
  nowMs: number,
): Promise<WatchCheckVerdict> {
  const versioned = (partial: Omit<WatchCheckVerdict, 'evidence'> & { evidence?: WatchEvaluationEvidence; dataAsOf?: string }): WatchCheckVerdict => ({
    ...partial,
    evidence: { ...(partial.evidence ?? { barCount: 0 }), watchVersion: watch.version, ...(partial.dataAsOf ? { dataAsOf: partial.dataAsOf } : {}) },
  })

  const ref: BarSourceRef = watch.source.assetClass
    ? { barId: watch.source.barId, assetClass: watch.source.assetClass }
    : { barId: watch.source.barId }
  let bars: OhlcvBar[]
  let meta: BarMeta
  try {
    const result = await deps.barService.getBars(ref, {
      interval: watch.source.interval,
      count: WATCH_CHECK_BARS,
    })
    bars = result.bars
    meta = result.meta
  } catch (err) {
    return versioned({
      status: 'unavailable',
      leaves: [],
      signalIds: [],
      reason: `bar fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  const gated = gateWatchFreshness({
    bars,
    interval: watch.source.interval,
    policy: watch.freshness,
    staleTradingDays: meta.staleTradingDays,
    anchorDate: meta.asOf,
    nowMs,
  })
  if (!gated.ok) {
    return versioned({ status: 'unavailable', leaves: [], signalIds: [], reason: gated.reason })
  }
  const closedBars = gated.closedBars

  const leaves = watchLeaves(watch.rule)
  const needsIndicators = leaves.some((leaf) => watchLeafDataKind[leaf.type] === 'indicators')
  // `auto` VWAP can select a recent structure anchor, so it needs the same
  // price-action context as an explicit structure VWAP. Price/EMA-only watches
  // stay on the cheap path: no zone/liquidity analysis just to read a close.
  const needsPriceAction = leaves.some((leaf) =>
    watchLeafDataKind[leaf.type] === 'priceAction'
    || (leaf.type === 'price_vs_vwap' && (leaf.anchor === undefined || leaf.anchor === 'auto' || leaf.anchor === 'structure')),
  )
  const priceAction = needsPriceAction
    ? analyzePriceActionBars({
      bars: closedBars,
      interval: watch.source.interval,
    })
    : undefined
  const indicators = needsIndicators
    ? buildTechnicalAnalysisIndicators(
      closedBars,
      priceAction?.marketStructure ?? createEmptyMarketStructure(),
      { ...watch.indicators, fibEnabled: false, confluenceEnabled: false },
    )
    : undefined
  const evaluation = evaluateWatch({ bars: closedBars, indicators, priceAction }, watch.rule)
  return versioned({
    status: evaluation.status,
    leaves: evaluation.leaves,
    signalIds: evaluation.signalIds,
    evidence: evaluation.evidence,
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    dataAsOf: gated.dataAsOf,
  })
}
