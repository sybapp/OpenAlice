/**
 * Pure `watch` rule evaluator — deterministic judgement over already-loaded
 * closed bars plus already-computed indicators / price action. No IO, no
 * fetching, no clock: the same inputs always yield the same verdict, which is
 * what makes fixed-bar replay specs meaningful.
 *
 * Anything the evaluator cannot judge (empty window, missing EMA/VWAP value,
 * uncomputable relation) is `unavailable`, never `miss`. Combination rule:
 * - single leaf → its own status;
 * - `all` → `hit` iff every leaf hits; else `unavailable` if any leaf is
 *   `unavailable` (cannot confirm all); else `miss`;
 * - `any` → `hit` if any leaf hits; else `unavailable` if any leaf is
 *   `unavailable`; else `miss`.
 */

import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import type { TechnicalAnalysisIndicatorResult } from '../indicators.js'
import type { PriceActionAnalysisResult } from '../price-action/analyze.js'
import type { FairValueGap, OrderBlock } from '../price-action/types.js'
import { fvgZoneId, orderBlockZoneId, structureBreakId } from './identity.js'
import { watchLeaves, type WatchLeaf, type WatchRule } from './spec.js'

export type WatchLeafStatus = 'hit' | 'miss' | 'unavailable'

export interface WatchLeafEvaluation {
  /** Position of the leaf in the rule (0 for a single-leaf rule). */
  index: number
  status: WatchLeafStatus
  /** Observed value (close, bias, relation, match count, …). */
  actual?: number | string
  /** Threshold / expectation from the leaf. */
  expected?: number | string
  /** Why `unavailable` (or extra context for a hit). */
  reason?: string
  /** Stable signal identities consumed by this leaf (hits only). */
  signalIds: string[]
}

export interface WatchEvaluationEvidence {
  close?: number
  previousClose?: number
  barFrom?: string
  barTo?: string
  barCount: number
}

export interface WatchEvaluation {
  status: WatchLeafStatus
  leaves: WatchLeafEvaluation[]
  /** Union of hit-leaf signal ids — the latch dedups on these. */
  signalIds: string[]
  evidence: WatchEvaluationEvidence
  /** Global reason when the whole evaluation is `unavailable`. */
  reason?: string
}

export interface WatchEvalInput {
  bars: readonly OhlcvBar[]
  indicators?: TechnicalAnalysisIndicatorResult
  priceAction?: PriceActionAnalysisResult
}

function leafResult(
  index: number,
  status: WatchLeafStatus,
  extra: Partial<Omit<WatchLeafEvaluation, 'index' | 'status'>> = {},
): WatchLeafEvaluation {
  return { index, status, signalIds: [], ...extra }
}

function lastCloses(bars: readonly OhlcvBar[]): { close?: number; previousClose?: number } {
  const close = bars.at(-1)?.close
  const previousClose = bars.at(-2)?.close
  return {
    ...(typeof close === 'number' && Number.isFinite(close) ? { close } : {}),
    ...(typeof previousClose === 'number' && Number.isFinite(previousClose) ? { previousClose } : {}),
  }
}

function evalPriceLeaf(leaf: WatchLeaf, index: number, bars: readonly OhlcvBar[]): WatchLeafEvaluation {
  if (leaf.type !== 'price_above' && leaf.type !== 'price_below'
    && leaf.type !== 'price_in_range' && leaf.type !== 'price_out_of_range'
    && leaf.type !== 'price_cross_above' && leaf.type !== 'price_cross_below'
    && leaf.type !== 'price_touch') {
    throw new Error(`evalPriceLeaf: not a price leaf: ${(leaf as WatchLeaf).type}`)
  }
  const { close, previousClose } = lastCloses(bars)
  if (close === undefined) {
    return leafResult(index, 'unavailable', { reason: 'no bars: last close is unknown' })
  }
  switch (leaf.type) {
    case 'price_above':
      return leafResult(index, close > leaf.price ? 'hit' : 'miss', { actual: close, expected: leaf.price })
    case 'price_below':
      return leafResult(index, close < leaf.price ? 'hit' : 'miss', { actual: close, expected: leaf.price })
    case 'price_in_range':
      return leafResult(index, close >= leaf.low && close <= leaf.high ? 'hit' : 'miss', {
        actual: close,
        expected: `[${leaf.low}, ${leaf.high}]`,
      })
    case 'price_out_of_range':
      return leafResult(index, close < leaf.low || close > leaf.high ? 'hit' : 'miss', {
        actual: close,
        expected: `outside [${leaf.low}, ${leaf.high}]`,
      })
    case 'price_cross_above': {
      if (previousClose === undefined) {
        return leafResult(index, 'unavailable', { actual: close, reason: 'needs two closed bars to judge a cross' })
      }
      return leafResult(index, previousClose <= leaf.price && close > leaf.price ? 'hit' : 'miss', {
        actual: close,
        expected: `cross above ${leaf.price} (prev ${previousClose})`,
      })
    }
    case 'price_cross_below': {
      if (previousClose === undefined) {
        return leafResult(index, 'unavailable', { actual: close, reason: 'needs two closed bars to judge a cross' })
      }
      return leafResult(index, previousClose >= leaf.price && close < leaf.price ? 'hit' : 'miss', {
        actual: close,
        expected: `cross below ${leaf.price} (prev ${previousClose})`,
      })
    }
    case 'price_touch': {
      const window = bars.slice(-(leaf.lookbackBars ?? 1))
      const touched = window.filter((bar) => bar.low <= leaf.price && bar.high >= leaf.price)
      return leafResult(index, touched.length > 0 ? 'hit' : 'miss', {
        actual: touched.length,
        expected: `${leaf.price} touch within last ${window.length} closed bar(s)`,
      })
    }
  }
}

function evalIndicatorLeaf(
  leaf: WatchLeaf,
  index: number,
  bars: readonly OhlcvBar[],
  indicators: TechnicalAnalysisIndicatorResult | undefined,
): WatchLeafEvaluation {
  if (leaf.type !== 'ema_alignment' && leaf.type !== 'price_vs_ema' && leaf.type !== 'price_vs_vwap') {
    throw new Error(`evalIndicatorLeaf: not an indicator leaf: ${(leaf as WatchLeaf).type}`)
  }
  const { close } = lastCloses(bars)
  if (indicators === undefined) {
    return leafResult(index, 'unavailable', { reason: 'indicator data is unavailable for this rule' })
  }
  if (leaf.type === 'ema_alignment') {
    const bias = indicators.ema.bias
    if (bias === 'unavailable') {
      return leafResult(index, 'unavailable', { reason: 'EMA bias is unavailable (insufficient bars)' })
    }
    return leafResult(index, bias === leaf.direction ? 'hit' : 'miss', {
      actual: bias,
      expected: leaf.direction,
    })
  }
  if (leaf.type === 'price_vs_ema') {
    const value = indicators.ema[leaf.which]
    if (value === undefined || !Number.isFinite(value)) {
      return leafResult(index, 'unavailable', { reason: `EMA ${leaf.which} is uncomputable on this window` })
    }
    if (close === undefined) {
      return leafResult(index, 'unavailable', { reason: 'no bars: last close is unknown' })
    }
    const hit = leaf.relation === 'above' ? close > value : close < value
    return leafResult(index, hit ? 'hit' : 'miss', { actual: close, expected: `${leaf.relation} EMA ${leaf.which} (${value})` })
  }
  // price_vs_vwap
  const vwap = indicators.vwap
  const relation = leaf.anchor !== undefined && leaf.anchor !== 'auto'
    ? (vwap?.anchors?.[leaf.anchor]?.relation ?? 'unavailable')
    : (vwap?.relation ?? 'unavailable')
  if (relation === 'unavailable') {
    return leafResult(index, 'unavailable', {
      reason: leaf.anchor !== undefined && leaf.anchor !== 'auto'
        ? `VWAP anchor ${leaf.anchor} is uncomputable on this window`
        : 'VWAP relation is unavailable (no usable volume or incomplete anchor)',
    })
  }
  return leafResult(index, relation === leaf.relation ? 'hit' : 'miss', {
    actual: relation,
    expected: leaf.relation,
  })
}

function evalStructureBreakLeaf(
  leaf: WatchLeaf,
  index: number,
  bars: readonly OhlcvBar[],
  priceAction: PriceActionAnalysisResult | undefined,
): WatchLeafEvaluation {
  if (leaf.type !== 'structure_break') {
    throw new Error(`evalStructureBreakLeaf: not a structure leaf: ${(leaf as WatchLeaf).type}`)
  }
  if (bars.length === 0) {
    return leafResult(index, 'unavailable', { reason: 'no bars: cannot place structure events' })
  }
  if (priceAction === undefined) {
    return leafResult(index, 'unavailable', { reason: 'price-action data is unavailable for this rule' })
  }
  const kinds = leaf.kind === 'any' ? (['BOS', 'CHoCH'] as const) : ([leaf.kind] as const)
  const signalIds: string[] = []
  let matched = 0
  for (const kind of kinds) {
    const events = kind === 'BOS' ? priceAction.marketStructure.bos : priceAction.marketStructure.choch
    for (const event of events) {
      if (leaf.direction !== undefined && event.type !== leaf.direction) continue
      if (leaf.level !== undefined && event.level !== leaf.level) continue
      const breakDate = bars[event.index]?.date
      if (breakDate === undefined) continue
      if (leaf.since !== undefined && breakDate < leaf.since) continue
      matched += 1
      signalIds.push(structureBreakId(kind, event, bars))
    }
  }
  if (matched === 0) {
    return leafResult(index, 'miss', {
      actual: 0,
      expected: `${leaf.kind}${leaf.direction ? ` ${leaf.direction}` : ''}${leaf.level ? ` ${leaf.level}` : ''} since ${leaf.since ?? 'window start'}`,
    })
  }
  return leafResult(index, 'hit', {
    actual: matched,
    expected: `${leaf.kind}${leaf.direction ? ` ${leaf.direction}` : ''}${leaf.level ? ` ${leaf.level}` : ''}`,
    signalIds,
  })
}

function zoneBand(zone: FairValueGap | OrderBlock): { top: number; bottom: number } {
  return { top: zone.top, bottom: zone.bottom }
}

function evalZoneTouchLeaf(
  leaf: WatchLeaf,
  index: number,
  bars: readonly OhlcvBar[],
  priceAction: PriceActionAnalysisResult | undefined,
): WatchLeafEvaluation {
  if (leaf.type !== 'zone_touch') {
    throw new Error(`evalZoneTouchLeaf: not a zone leaf: ${(leaf as WatchLeaf).type}`)
  }
  if (bars.length === 0) {
    return leafResult(index, 'unavailable', { reason: 'no bars: cannot judge a zone touch' })
  }
  if (priceAction === undefined) {
    return leafResult(index, 'unavailable', { reason: 'price-action data is unavailable for this rule' })
  }
  const zones: Array<{ id: string; top: number; bottom: number }> = leaf.zone === 'FVG'
    ? priceAction.fvgs
      .filter((zone: FairValueGap) => !zone.completelyFilled)
      .map((zone: FairValueGap) => ({ id: fvgZoneId(zone, bars), ...zoneBand(zone) }))
    : priceAction.orderBlocks
      .filter((zone: OrderBlock) => !zone.mitigated)
      .map((zone: OrderBlock) => ({ id: orderBlockZoneId(zone, bars), ...zoneBand(zone) }))
  const lookback = leaf.lookbackBars ?? 1
  const window = bars.slice(-lookback)
  const touched = zones.filter((zone) =>
    window.some((bar) => bar.low <= zone.top && bar.high >= zone.bottom),
  )
  if (touched.length === 0) {
    return leafResult(index, 'miss', {
      actual: 0,
      expected: `${leaf.zone} touch within last ${window.length} bar(s) (${zones.length} active zone(s))`,
    })
  }
  return leafResult(index, 'hit', {
    actual: touched.length,
    expected: `${leaf.zone} touch`,
    reason: `${touched.length} of ${zones.length} active zone(s) touched in last ${window.length} bar(s)`,
    signalIds: touched.map((zone) => zone.id),
  })
}

function assertNever(value: never): never {
  throw new Error(`Unsupported watch leaf: ${String(value)}`)
}

function evalLeaf(
  leaf: WatchLeaf,
  index: number,
  input: WatchEvalInput,
): WatchLeafEvaluation {
  switch (leaf.type) {
    case 'price_above':
    case 'price_below':
    case 'price_in_range':
    case 'price_out_of_range':
    case 'price_cross_above':
    case 'price_cross_below':
    case 'price_touch':
      return evalPriceLeaf(leaf, index, input.bars)
    case 'ema_alignment':
    case 'price_vs_ema':
    case 'price_vs_vwap':
      return evalIndicatorLeaf(leaf, index, input.bars, input.indicators)
    case 'structure_break':
      return evalStructureBreakLeaf(leaf, index, input.bars, input.priceAction)
    case 'zone_touch':
      return evalZoneTouchLeaf(leaf, index, input.bars, input.priceAction)
    default:
      return assertNever(leaf)
  }
}

function combine(leaves: WatchLeafEvaluation[], mode: 'all' | 'any'): WatchLeafStatus {
  if (mode === 'all') {
    if (leaves.every((leaf) => leaf.status === 'hit')) return 'hit'
    if (leaves.some((leaf) => leaf.status === 'unavailable')) return 'unavailable'
    return 'miss'
  }
  if (leaves.some((leaf) => leaf.status === 'hit')) return 'hit'
  if (leaves.some((leaf) => leaf.status === 'unavailable')) return 'unavailable'
  return 'miss'
}

/** Deterministic judgement over loaded closed bars. Never throws on data —
 * empty windows and uncomputable values yield `unavailable`. */
export function evaluateWatch(input: WatchEvalInput, rule: WatchRule): WatchEvaluation {
  const { close, previousClose } = lastCloses(input.bars)
  const evidence: WatchEvaluationEvidence = {
    ...(close !== undefined ? { close } : {}),
    ...(previousClose !== undefined ? { previousClose } : {}),
    ...(input.bars[0] ? { barFrom: input.bars[0].date } : {}),
    ...(input.bars.at(-1) ? { barTo: input.bars.at(-1)!.date } : {}),
    barCount: input.bars.length,
  }
  if (input.bars.length === 0) {
    return {
      status: 'unavailable',
      leaves: [],
      signalIds: [],
      evidence,
      reason: 'no bars loaded for this window',
    }
  }
  const leaves: WatchLeafEvaluation[] = watchLeaves(rule).map((leaf, index) => evalLeaf(leaf, index, input))
  const mode = 'all' in rule ? 'all' : 'any' in rule ? 'any' : null
  const status = mode === null ? leaves[0]!.status : combine(leaves, mode)
  return {
    status,
    leaves,
    signalIds: leaves.flatMap((leaf) => (leaf.status === 'hit' ? leaf.signalIds : [])),
    evidence,
  }
}
