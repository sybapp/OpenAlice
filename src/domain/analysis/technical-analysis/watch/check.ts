/**
 * `watch` check orchestration — fetch → freshness/closed-bar gate →
 * selective compute → pure evaluation. This is the internal seam the
 * scanner will call (increment 2); the scanner owns latch/state/dispatch,
 * this module owns one judgement over live data.
 *
 * Cost control: one deduplicated `getBars` per unique source/interval,
 * indicator fib/confluence forced off (unused by the verdict),
 * and the order-flow path (`analyzeTechnicalAnalysisInterval`) never runs —
 * only `analyzePriceActionBars` + `buildTechnicalAnalysisIndicators` on the
 * loaded closed bars.
 *
 * Error contract: a `getBars` throw becomes `unavailable` (never a miss, so
 * a dead source cannot silently read as "condition false"). Compute errors
 * propagate — they are deterministic bugs the replay specs must catch, and
 * the scanner isolates per-issue check failures.
 */

import type { BarService, BarSourceRef } from '../../../market-data/bars/types.js'
import { analyzePriceActionBars, createEmptyMarketStructure } from '../price-action/analyze.js'
import { buildTechnicalAnalysisIndicators } from '../indicators.js'
import {
  evaluateWatch,
  type WatchContext,
  type WatchEvaluationEvidence,
  type WatchLeafEvaluation,
} from './eval.js'
import { gateWatchFreshness } from './freshness.js'
import {
  needsPriceAction,
  WATCH_MAX_CONTEXTS,
  watchContexts,
  watchLeafDataKind,
  watchLeaves,
  type IssueWatch,
  type WatchSource,
} from './spec.js'

/** Bars loaded per check. Covers the ATR-200 default, EMA-50 default, and
 * the external-structure 101-bar window with headroom. */
export const WATCH_CHECK_BARS = 200
export const WATCH_MAX_CONCURRENT_FETCHES = 4
/** Total bar budget: at most 5 contexts × 200 bars per check. */
export const WATCH_MAX_TOTAL_BARS = WATCH_MAX_CONTEXTS * WATCH_CHECK_BARS

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

function sourceRef(source: WatchSource): BarSourceRef {
  return source.assetClass
    ? { barId: source.barId, assetClass: source.assetClass }
    : { barId: source.barId }
}

function sourceFetchKey(source: WatchSource): string {
  return `${source.barId}\u0000${source.interval}`
}

export async function checkWatch(
  deps: WatchCheckDeps,
  watch: IssueWatch,
  nowMs: number,
): Promise<WatchCheckVerdict> {
  const leaves = watchLeaves(watch.rule)
  const sources = Object.entries(watchContexts(watch))
    .filter(([name]) => leaves.some((leaf) => (leaf.source ?? 'default') === name))
  const fetches = new Map<string, ReturnType<WatchCheckDeps['barService']['getBars']>>()

  const loadContext = async (name: string, source: WatchSource): Promise<WatchContext> => {
    const key = sourceFetchKey(source)
    let fetch = fetches.get(key)
    if (fetch === undefined) {
      fetch = Promise.resolve().then(() =>
        deps.barService.getBars(sourceRef(source), { interval: source.interval, count: WATCH_CHECK_BARS }),
      )
      fetches.set(key, fetch)
    }
    try {
      const result = await fetch
      const gated = gateWatchFreshness({
        bars: result.bars,
        interval: source.interval,
        policy: watch.freshness,
        staleTradingDays: result.meta.staleTradingDays,
        anchorDate: result.meta.asOf,
        nowMs,
      })
      if (!gated.ok) return { status: 'unavailable', reason: gated.reason }
      const contextLeaves = leaves.filter((leaf) => (leaf.source ?? 'default') === name)
      const needsIndicators = contextLeaves.some((leaf) => watchLeafDataKind[leaf.type] === 'indicators')
      const priceAction = contextLeaves.some(needsPriceAction)
        ? analyzePriceActionBars({ bars: gated.closedBars, interval: source.interval })
        : undefined
      const indicators = needsIndicators
        ? buildTechnicalAnalysisIndicators(
          gated.closedBars,
          priceAction?.marketStructure ?? createEmptyMarketStructure(),
          { ...watch.indicators, fibEnabled: false, confluenceEnabled: false },
        )
        : undefined
      return { status: 'ready', bars: gated.closedBars, indicators, priceAction, dataAsOf: gated.dataAsOf }
    } catch (err) {
      return { status: 'unavailable', reason: `bar fetch failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  // ponytail: fixed worker pool, results slotted by index so evidence key order is deterministic.
  const results = new Array<WatchContext>(sources.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(WATCH_MAX_CONCURRENT_FETCHES, sources.length) }, async () => {
    for (;;) {
      const slot = next++
      const entry = sources[slot]
      if (entry === undefined) return
      const [name, source] = entry
      results[slot] = await loadContext(name, source)
    }
  }))
  const contexts = new Map<string, WatchContext>(sources.map(([name], i) => [name, results[i]!]))
  const evaluation = evaluateWatch({ contexts }, watch.rule)
  const dataAsOf = evaluation.evidence.contexts?.default?.dataAsOf
  return {
    status: evaluation.status,
    leaves: evaluation.leaves,
    signalIds: evaluation.signalIds,
    evidence: {
      ...evaluation.evidence,
      watchVersion: watch.version,
      ...(dataAsOf !== undefined ? { dataAsOf } : {}),
    },
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
  }
}
