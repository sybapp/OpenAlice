import type {
  AccumulationDistributionZone,
  BalancePriceRange,
  ConfluenceZone,
  EqualHighLow,
  FairValueGap,
  FibRetracement,
  LiquidityZone,
  NormalizedTechnicalAnalysisOptions,
  NormalizedTechnicalAnalysisBprOptions,
  NormalizedTechnicalAnalysisConfluenceZoneOptions,
  NormalizedTechnicalAnalysisFibOptions,
  NormalizedTechnicalAnalysisLiquidityOptions,
  NormalizedTechnicalAnalysisLimitsOptions,
  NormalizedTechnicalAnalysisStopZoneOptions,
  NormalizedTechnicalAnalysisUnusualVolumeOptions,
  NormalizedTechnicalAnalysisVolumeProfileOptions,
  NormalizedTechnicalAnalysisVwapDeviationOptions,
  NormalizedTechnicalAnalysisZoneFilterOptions,
  OrderBlock,
  PivotLevel,
  PremiumDiscountZone,
  PricePivot,
  StopZone,
  StrongWeakLevel,
  StructureEvent,
  TechnicalAnalysisAnalysis,
  TechnicalAnalysisCandle,
  TechnicalAnalysisConfluence,
  TechnicalAnalysisDirection,
  TechnicalAnalysisOptions,
  TechnicalAnalysisRelevance,
  TechnicalAnalysisRelevantZone,
  VolumePriceSignal,
  VolumeProfileSnapshot,
  VwapDeviationContext,
} from './types.js'

import { anchoredVwap, avg, ema, inferEmaBias, isIntradayCandles, latestPositiveAtr, monthKeyForTime, rollingVwap, round, selectVwapForIndex, sessionVwap, standardDeviation, structureVwap, vwapRelation, weekKeyForTime, yearKeyForTime } from './helpers.js'

export interface ConfluenceSeries {
  byIndex: Array<TechnicalAnalysisConfluence | undefined>
  latest?: TechnicalAnalysisConfluence
}

export function detectFibRetracements(
  candles: TechnicalAnalysisCandle[],
  pivots: PricePivot[],
  events: StructureEvent[],
  options: NormalizedTechnicalAnalysisOptions,
): FibRetracement[] {
  if (!options.fib.enabled || candles.length === 0) return []
  const swingEvent = [...events].reverse().find((event) => event.level === 'swing')
  const event = swingEvent ?? events.at(-1)
  if (!event) return []

  const relevantPivots = pivots
    .filter((pivot) => pivot.level === event.level && pivot.index <= event.index)
    .sort((a, b) => a.index - b.index)
  const startPivot = [...relevantPivots].reverse().find((pivot) =>
    event.direction === 'bullish' ? pivot.kind === 'low' : pivot.kind === 'high')
  if (!startPivot) return []

  let endIndex = startPivot.index
  let endPrice = event.direction === 'bullish' ? candles[startPivot.index].high : candles[startPivot.index].low
  for (let index = startPivot.index; index <= event.index; index += 1) {
    if (event.direction === 'bullish') {
      if (candles[index].high > endPrice) {
        endPrice = candles[index].high
        endIndex = index
      }
    } else if (candles[index].low < endPrice) {
      endPrice = candles[index].low
      endIndex = index
    }
  }

  const startPrice = startPivot.price
  const range = Math.abs(endPrice - startPrice)
  if (!Number.isFinite(range) || range <= 0) return []

  const levels = options.fib.levels.map((ratio) => {
    const price = event.direction === 'bullish'
      ? endPrice - range * ratio
      : endPrice + range * ratio
    let touched = false
    let crossed = false
    const from = Math.min(endIndex + 1, candles.length - 1)
    for (let i = from; i < candles.length; i += 1) {
      if (candles[i].high >= price && candles[i].low <= price) touched = true
      if (event.direction === 'bullish' && candles[i].close < price) crossed = true
      if (event.direction === 'bearish' && candles[i].close > price) crossed = true
      if (crossed) break
    }
    return { ratio, price: round(price, 6), touched, crossed }
  })

  const latestClose = candles.at(-1)?.close ?? endPrice
  const status = event.direction === 'bullish'
    ? latestClose < startPrice ? 'broken' : 'active'
    : latestClose > startPrice ? 'broken' : 'active'

  return [{
    id: `fib-${event.level}-${event.direction}-${startPivot.index}-${endIndex}`,
    direction: event.direction,
    index: event.index,
    time: event.time,
    startIndex: startPivot.index,
    startTime: startPivot.time,
    startPrice: round(startPrice, 6),
    endIndex,
    endTime: candles[endIndex].time,
    endPrice: round(endPrice, 6),
    levels,
    status,
  }]
}

export function detectConfluenceZones(
  candles: TechnicalAnalysisCandle[],
  fibRetracements: FibRetracement[],
  confluence: TechnicalAnalysisConfluence | undefined,
  options: NormalizedTechnicalAnalysisOptions,
): ConfluenceZone[] {
  if (!options.confluenceZone.enabled || candles.length === 0) return []
  const latestIndex = candles.length - 1
  const latestClose = candles[latestIndex].close
  const latestAtr = latestPositiveAtr(candles, options.atrPeriod)
  const tolerance = Math.max(latestAtr * options.confluenceZone.overlapAtrMultiplier, 1e-6)
  type Point = { family: 'ema' | 'vwap' | 'fib', label: string, price: number }
  const points: Point[] = []

  if (confluence?.emaFast !== undefined) points.push({ family: 'ema', label: 'ema_fast', price: confluence.emaFast })
  if (confluence?.emaSlow !== undefined) points.push({ family: 'ema', label: 'ema_slow', price: confluence.emaSlow })
  if (confluence?.emaLong !== undefined) points.push({ family: 'ema', label: 'ema_long', price: confluence.emaLong })
  if (confluence?.vwap !== undefined) points.push({ family: 'vwap', label: `vwap_${confluence.vwapAnchor ?? 'auto'}`, price: confluence.vwap })
  for (const retracement of fibRetracements.filter((item) => item.status === 'active')) {
    for (const level of retracement.levels) {
      points.push({ family: 'fib', label: `fib_${level.ratio}`, price: level.price })
    }
  }
  if (points.length < options.confluenceZone.minFamilies) return []

  const sorted = [...points].sort((a, b) => a.price - b.price)
  const groups: Point[][] = []
  let current: Point[] = []
  for (const point of sorted) {
    if (current.length === 0) {
      current.push(point)
      continue
    }
    const currentMid = avg(current.map((entry) => entry.price))
    if (Math.abs(point.price - currentMid) <= tolerance) {
      current.push(point)
    } else {
      groups.push(current)
      current = [point]
    }
  }
  if (current.length > 0) groups.push(current)

  const zones: ConfluenceZone[] = groups
    .map((group, idx) => {
      const families = [...new Set(group.map((entry) => entry.family))]
      if (families.length < options.confluenceZone.minFamilies) return null
      const top = Math.max(...group.map((entry) => entry.price))
      const bottom = Math.min(...group.map((entry) => entry.price))
      const midpoint = (top + bottom) / 2
      return {
        id: `confluence-${latestIndex}-${idx}`,
        index: latestIndex,
        time: candles[latestIndex].time,
        top: round(top, 6),
        bottom: round(bottom, 6),
        midpoint: round(midpoint, 6),
        families,
        components: group.map((entry) => entry.label),
        strength: families.length * 2 + group.length,
        classification: top < latestClose ? 'support' : bottom > latestClose ? 'resistance' : 'pivot',
        status: 'active' as const,
      }
    })
    .filter((zone): zone is ConfluenceZone => zone !== null)
    .sort((a, b) => b.strength - a.strength || Math.abs(a.midpoint - latestClose) - Math.abs(b.midpoint - latestClose))

  return zones.slice(0, options.confluenceZone.maxVisible)
}

export function buildConfluenceSeries(
  candles: TechnicalAnalysisCandle[],
  events: StructureEvent[],
  options: NormalizedTechnicalAnalysisOptions,
): ConfluenceSeries {
  const byIndex: Array<TechnicalAnalysisConfluence | undefined> = new Array(candles.length)
  if (candles.length === 0) return { byIndex }

  const emaFast = ema(candles, options.emaFastPeriod)
  const emaSlow = ema(candles, options.emaSlowPeriod)
  const emaLong = ema(candles, options.emaLongPeriod)
  const rolling = options.vwapEnabled ? rollingVwap(candles, options.volumeLookback) : undefined
  const session = options.vwapEnabled ? sessionVwap(candles) : undefined
  const week = options.vwapEnabled ? anchoredVwap(candles, weekKeyForTime) : undefined
  const month = options.vwapEnabled ? anchoredVwap(candles, monthKeyForTime) : undefined
  const year = options.vwapEnabled ? anchoredVwap(candles, yearKeyForTime) : undefined
  const structure = options.vwapEnabled ? structureVwap(candles, events) : undefined
  const intraday = isIntradayCandles(candles)

  for (let index = 0; index < candles.length; index += 1) {
    const close = candles[index].close
    const fast = emaFast[index]
    const slow = emaSlow[index]
    const long = emaLong[index]
    const emaBias = inferEmaBias(close, fast, slow, long)

    const vwapContext = options.vwapEnabled
      ? selectVwapForIndex(candles, index, options.vwapAnchor, intraday, rolling, session, week, month, year, structure, events, options.volumeLookback)
      : { value: Number.NaN, anchor: undefined as 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure' | undefined }
    const relation = vwapRelation(close, vwapContext.value)
    const vwapScore = relation === 'above' ? 0.5 : relation === 'below' ? -0.5 : 0
    const emaScore = emaBias === 'bullish' ? 1 : emaBias === 'bearish' ? -1 : 0

    byIndex[index] = {
      score: round(emaScore + vwapScore, 4),
      ...(Number.isFinite(fast) ? { emaFast: round(fast, 6) } : {}),
      ...(Number.isFinite(slow) ? { emaSlow: round(slow, 6) } : {}),
      ...(Number.isFinite(long) ? { emaLong: round(long, 6) } : {}),
      emaBias,
      ...(Number.isFinite(vwapContext.value) ? { vwap: round(vwapContext.value, 6) } : {}),
      ...(vwapContext.anchor ? { vwapAnchor: vwapContext.anchor } : {}),
      vwapRelation: relation,
    }
  }

  return {
    byIndex,
    latest: byIndex.at(-1),
  }
}

export function confluenceScoreForDirection(confluence: TechnicalAnalysisConfluence | undefined, direction?: TechnicalAnalysisDirection): number | undefined {
  if (!confluence || !direction) return undefined
  let score = 0
  if (confluence.emaBias === 'bullish') score += direction === 'bullish' ? 1 : -1
  if (confluence.emaBias === 'bearish') score += direction === 'bearish' ? 1 : -1
  if (confluence.vwapRelation === 'above') score += direction === 'bullish' ? 0.5 : -0.5
  if (confluence.vwapRelation === 'below') score += direction === 'bearish' ? 0.5 : -0.5
  return round(score, 4)
}
