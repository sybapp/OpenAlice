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

import { atr, averageRange, classifyVolume, pivotKey, round, volumeScore } from './helpers.js'

export interface ZonePoint {
  pivot: PricePivot
  c: 1 | -1
}

export function detectPivots(candles: TechnicalAnalysisCandle[], lookback: number, level: PivotLevel): PricePivot[] {
  const pivots: PricePivot[] = []
  if (candles.length < lookback * 2 + 1) return pivots

  for (let index = lookback; index < candles.length - lookback; index += 1) {
    const candle = candles[index]
    let isHigh = true
    let isLow = true
    for (let j = index - lookback; j <= index + lookback; j += 1) {
      if (j === index) continue
      if (candles[j].high >= candle.high) isHigh = false
      if (candles[j].low <= candle.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) pivots.push({ index, time: candle.time, price: candle.high, kind: 'high', level })
    if (isLow) pivots.push({ index, time: candle.time, price: candle.low, kind: 'low', level })
  }
  return pivots
}

export function detectStructureEvents(
  candles: TechnicalAnalysisCandle[],
  pivots: PricePivot[],
  level: PivotLevel,
  options: NormalizedTechnicalAnalysisOptions,
): StructureEvent[] {
  const events: StructureEvent[] = []
  const highs = pivots.filter((pivot) => pivot.kind === 'high')
  const lows = pivots.filter((pivot) => pivot.kind === 'low')
  const confirmationLookback = level === 'internal' ? options.internalLookback : options.swingLookback
  let trend = 0
  let highCursor = 0
  let lowCursor = 0
  const broken = new Set<string>()

  for (let index = 0; index < candles.length; index += 1) {
    while (highCursor < highs.length && highs[highCursor].index + confirmationLookback < index) highCursor += 1
    while (lowCursor < lows.length && lows[lowCursor].index + confirmationLookback < index) lowCursor += 1

    const lastHigh = findLastUnbrokenPivot(highs, highCursor - 1, broken)
    const lastLow = findLastUnbrokenPivot(lows, lowCursor - 1, broken)
    const candle = candles[index]
    const bullishBreak = lastHigh && breakAbove(candle, lastHigh.price, options.useCloseBreak)
    const bearishBreak = lastLow && breakBelow(candle, lastLow.price, options.useCloseBreak)

    if (bullishBreak && lastHigh) {
      const type: StructureEvent['type'] = trend < 1 ? 'MSS' : 'BOS'
      const event = buildStructureEvent(candles, index, 'bullish', type, level, lastHigh, candle, options)
      events.push(event)
      broken.add(pivotKey(lastHigh))
      trend = 1
      continue
    }

    if (bearishBreak && lastLow) {
      const type: StructureEvent['type'] = trend > -1 ? 'MSS' : 'BOS'
      const event = buildStructureEvent(candles, index, 'bearish', type, level, lastLow, candle, options)
      events.push(event)
      broken.add(pivotKey(lastLow))
      trend = -1
    }
  }

  return events
}

export function detectEqualHighLows(candles: TechnicalAnalysisCandle[], options: NormalizedTechnicalAnalysisOptions): EqualHighLow[] {
  const pivots = detectPivots(candles, 1, 'internal')
  const atrValues = atr(candles, options.atrPeriod)
  const result: EqualHighLow[] = []
  let lastHigh: PricePivot | undefined
  let lastLow: PricePivot | undefined

  for (const pivot of pivots) {
    const tolerance = (atrValues[pivot.index] ?? averageRange(candles)) * options.equalToleranceAtr
    if (pivot.kind === 'high') {
      if (lastHigh && Math.max(pivot.price, lastHigh.price) < Math.min(pivot.price, lastHigh.price) + tolerance) {
        result.push({
          id: `eqh-${lastHigh.index}-${pivot.index}`,
          kind: 'EQH',
          index: pivot.index,
          time: pivot.time,
          previousIndex: lastHigh.index,
          previousTime: lastHigh.time,
          price: pivot.price,
          previousPrice: lastHigh.price,
          tolerance,
        })
      }
      lastHigh = pivot
    } else {
      if (lastLow && Math.min(pivot.price, lastLow.price) > Math.max(pivot.price, lastLow.price) - tolerance) {
        result.push({
          id: `eql-${lastLow.index}-${pivot.index}`,
          kind: 'EQL',
          index: pivot.index,
          time: pivot.time,
          previousIndex: lastLow.index,
          previousTime: lastLow.time,
          price: pivot.price,
          previousPrice: lastLow.price,
          tolerance,
        })
      }
      lastLow = pivot
    }
  }
  return result
}

export function detectAccumulationDistribution(pivots: PricePivot[], options: NormalizedTechnicalAnalysisOptions): AccumulationDistributionZone[] {
  const points: ZonePoint[] = []
  const zones: AccumulationDistributionZone[] = []
  const needed = options.zoneMode === 'Fast' ? 4 : 6

  for (const pivot of pivots.sort((a, b) => a.index - b.index)) {
    const point: ZonePoint = { pivot, c: pivot.kind === 'high' ? 1 : -1 }
    points.unshift(point)
    if (points.length > 1 && points[0].c === points[1].c) points.length = 0
    if (points.length < needed) continue

    const slice = points.slice(0, needed)
    const accumulation = matchesAccumulation(slice)
    const distribution = matchesDistribution(slice)
    if (!accumulation && !distribution) continue

    const ordered = [...slice].sort((a, b) => a.pivot.index - b.pivot.index)
    const prices = ordered.map((item) => item.pivot.price)
    zones.push({
      id: `${accumulation ? 'acc' : 'dist'}-${ordered[0].pivot.index}-${ordered.at(-1)?.pivot.index}`,
      type: accumulation ? 'Accumulation' : 'Distribution',
      mode: options.zoneMode,
      startIndex: ordered[0].pivot.index,
      endIndex: ordered.at(-1)!.pivot.index,
      startTime: ordered[0].pivot.time,
      endTime: ordered.at(-1)!.pivot.time,
      top: Math.max(...prices),
      bottom: Math.min(...prices),
    })
    points.length = 0
  }

  return zones
}

export function buildPremiumDiscount(pivots: PricePivot[]): PremiumDiscountZone | undefined {
  const lastHigh = [...pivots].reverse().find((pivot) => pivot.kind === 'high')
  const lastLow = [...pivots].reverse().find((pivot) => pivot.kind === 'low')
  if (!lastHigh || !lastLow || lastHigh.price <= lastLow.price) return undefined
  const equilibrium = (lastHigh.price + lastLow.price) / 2
  return {
    high: lastHigh.price,
    low: lastLow.price,
    premiumTop: lastHigh.price,
    premiumBottom: lastHigh.price * 0.95 + lastLow.price * 0.05,
    equilibrium,
    discountTop: lastHigh.price * 0.05 + lastLow.price * 0.95,
    discountBottom: lastLow.price,
    fromIndex: Math.min(lastHigh.index, lastLow.index),
    toIndex: Math.max(lastHigh.index, lastLow.index),
  }
}

export function buildStrongWeakLevels(candles: TechnicalAnalysisCandle[], pivots: PricePivot[], events: StructureEvent[]): StrongWeakLevel[] {
  const trend = inferTrend(events)
  const latestHigh = [...pivots].reverse().find((pivot) => pivot.kind === 'high')
  const latestLow = [...pivots].reverse().find((pivot) => pivot.kind === 'low')
  if (!latestHigh || !latestLow) return []
  const highVolume = candles[latestHigh.index]?.volume ?? null
  const lowVolume = candles[latestLow.index]?.volume ?? null
  const total = (highVolume ?? 0) + (lowVolume ?? 0)

  return [
    {
      kind: 'high',
      strength: trend === 'bearish' ? 'strong' : 'weak',
      index: latestHigh.index,
      time: latestHigh.time,
      price: latestHigh.price,
      volume: highVolume,
      volumeShare: total > 0 && highVolume ? round((highVolume / total) * 100, 2) : undefined,
    },
    {
      kind: 'low',
      strength: trend === 'bullish' ? 'strong' : 'weak',
      index: latestLow.index,
      time: latestLow.time,
      price: latestLow.price,
      volume: lowVolume,
      volumeShare: total > 0 && lowVolume ? round((lowVolume / total) * 100, 2) : undefined,
    },
  ]
}

export function matchesAccumulation(points: ZonePoint[]): boolean {
  if (!points.every((point, index) => point.c === (index % 2 === 0 ? -1 : 1))) return false
  const lows = points.filter((point) => point.c === -1).map((point) => point.pivot.price)
  const highs = points.filter((point) => point.c === 1).map((point) => point.pivot.price)
  return strictlyDescending(lows) && strictlyAscending(highs)
}

export function matchesDistribution(points: ZonePoint[]): boolean {
  if (!points.every((point, index) => point.c === (index % 2 === 0 ? 1 : -1))) return false
  const highs = points.filter((point) => point.c === 1).map((point) => point.pivot.price)
  const lows = points.filter((point) => point.c === -1).map((point) => point.pivot.price)
  return strictlyAscending(highs) && strictlyDescending(lows)
}

export function strictlyDescending(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] > value)
}

export function strictlyAscending(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value)
}

export function inferTrend(events: StructureEvent[]): 'bullish' | 'bearish' | 'neutral' {
  const latest = events.at(-1)
  if (!latest) return 'neutral'
  return latest.direction
}

export function breakAbove(candle: TechnicalAnalysisCandle, price: number, useClose: boolean): boolean {
  return useClose ? candle.close > price : candle.high > price
}

export function breakBelow(candle: TechnicalAnalysisCandle, price: number, useClose: boolean): boolean {
  return useClose ? candle.close < price : candle.low < price
}

export function findLastUnbrokenPivot(pivots: PricePivot[], start: number, broken: Set<string>): PricePivot | undefined {
  for (let index = start; index >= 0; index -= 1) {
    const pivot = pivots[index]
    if (!broken.has(pivotKey(pivot))) return pivot
  }
  return undefined
}

export function buildStructureEvent(
  candles: TechnicalAnalysisCandle[],
  index: number,
  direction: TechnicalAnalysisDirection,
  type: StructureEvent['type'],
  level: PivotLevel,
  pivot: PricePivot,
  candle: TechnicalAnalysisCandle,
  options: NormalizedTechnicalAnalysisOptions,
): StructureEvent {
  const zScore = volumeScore(candles, index, options.volumeLookback)
  return {
    id: `${level}-${type.toLowerCase()}-${direction}-${pivot.index}-${index}`,
    index,
    time: candle.time,
    direction,
    type,
    level,
    brokenPivot: pivot,
    breakPrice: pivot.price,
    close: candle.close,
    volume: candle.volume ?? null,
    volumeZScore: Number.isFinite(zScore) ? round(zScore, 4) : undefined,
    volumeConfirmation: classifyVolume(candles, index, options.volumeLookback),
  }
}
