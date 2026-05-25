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

import { compareTime, latestPositiveAtr, round } from './helpers.js'

export function buildRelevance(
  candles: TechnicalAnalysisCandle[],
  orderBlocks: OrderBlock[],
  fairValueGaps: FairValueGap[],
  liquidityZones: LiquidityZone[],
  balancePriceRanges: BalancePriceRange[],
  confluenceZones: ConfluenceZone[],
  options: NormalizedTechnicalAnalysisOptions,
): TechnicalAnalysisRelevance {
  if (candles.length === 0) return emptyRelevance()

  const latestIndex = candles.length - 1
  const latestClose = candles[latestIndex].close
  const latestAtr = latestPositiveAtr(candles, options.atrPeriod)
  const filter = options.zoneFilter
  const obReasons: Record<string, number> = {}
  const fvgReasons: Record<string, number> = {}
  const liqReasons: Record<string, number> = {}
  const bprReasons: Record<string, number> = {}
  const confluenceReasons: Record<string, number> = {}

  const filteredOrderBlocks = orderBlocks.filter((block) => {
    if (!filter.enabled) return true
    if (block.invalidated && !filter.includeInvalidatedOrderBlocks) return reject(obReasons, 'invalidated')
    if (block.mitigated && !filter.includeMitigatedOrderBlocks) return reject(obReasons, 'mitigated')
    if (isTooOld(block.index, latestIndex, filter.maxAgeBars)) return reject(obReasons, 'too_old')
    if (isTooFar(block.bottom, block.top, latestClose, latestAtr, filter.maxDistanceAtr)) return reject(obReasons, 'too_far')
    return true
  })

  const filteredGaps = fairValueGaps.filter((gap) => {
    if (!filter.enabled) return true
    if (gap.filled && !filter.includeFilledFairValueGaps) return reject(fvgReasons, 'filled')
    if (gap.status === 'broken' && !filter.includeFilledFairValueGaps) return reject(fvgReasons, 'broken')
    if (isTooOld(gap.index, latestIndex, filter.maxAgeBars)) return reject(fvgReasons, 'too_old')
    if (isTooFar(gap.bottom, gap.top, latestClose, latestAtr, filter.maxDistanceAtr)) return reject(fvgReasons, 'too_far')
    if (isGapTooSmall(gap, latestClose, latestAtr, filter)) return reject(fvgReasons, 'too_small')
    return true
  })
  const filteredLiquidity = liquidityZones.filter((zone) => {
    if (!filter.enabled) return true
    if (zone.status === 'swept') return reject(liqReasons, 'swept')
    if (isTooOld(zone.index, latestIndex, filter.maxAgeBars)) return reject(liqReasons, 'too_old')
    if (isTooFar(zone.bottom, zone.top, latestClose, latestAtr, filter.maxDistanceAtr)) return reject(liqReasons, 'too_far')
    return true
  })
  const filteredBpr = balancePriceRanges.filter((range) => {
    if (!filter.enabled) return true
    if (range.status === 'broken') return reject(bprReasons, 'broken')
    if (isTooOld(range.index, latestIndex, filter.maxAgeBars)) return reject(bprReasons, 'too_old')
    if (isTooFar(range.bottom, range.top, latestClose, latestAtr, filter.maxDistanceAtr)) return reject(bprReasons, 'too_far')
    return true
  })
  const filteredConfluence = confluenceZones.filter((zone) => {
    if (!filter.enabled) return true
    if (isTooFar(zone.bottom, zone.top, latestClose, latestAtr, filter.maxDistanceAtr)) return reject(confluenceReasons, 'too_far')
    return true
  })

  const relevantOrderBlocks = filteredOrderBlocks
    .sort((a, b) => compareZonePriority(zoneFromOrderBlock(a, latestClose, latestAtr), zoneFromOrderBlock(b, latestClose, latestAtr)))
    .slice(0, filter.maxZones)
  const relevantGaps = (filter.mergeOverlappingZones ? mergeFairValueGaps(filteredGaps) : filteredGaps)
    .sort((a, b) => compareZonePriority(zoneFromFairValueGap(a, latestClose, latestAtr), zoneFromFairValueGap(b, latestClose, latestAtr)))
    .slice(0, filter.maxZones)
  const relevantLiquidity = filteredLiquidity
    .sort((a, b) => compareZonePriority(zoneFromLiquidity(a, latestClose, latestAtr), zoneFromLiquidity(b, latestClose, latestAtr)))
    .slice(0, options.liquidity.maxVisible)
  const relevantBpr = filteredBpr
    .sort((a, b) => compareZonePriority(zoneFromBpr(a, latestClose, latestAtr), zoneFromBpr(b, latestClose, latestAtr)))
    .slice(0, options.bpr.maxVisible)
  const relevantConfluence = filteredConfluence
    .sort((a, b) => compareZonePriority(zoneFromConfluence(a, latestClose, latestAtr), zoneFromConfluence(b, latestClose, latestAtr)))
    .slice(0, options.confluenceZone.maxVisible)

  const zones = [
    ...relevantOrderBlocks.map((block) => zoneFromOrderBlock(block, latestClose, latestAtr)),
    ...relevantGaps.map((gap) => zoneFromFairValueGap(gap, latestClose, latestAtr)),
    ...relevantLiquidity.map((zone) => zoneFromLiquidity(zone, latestClose, latestAtr)),
    ...relevantBpr.map((zone) => zoneFromBpr(zone, latestClose, latestAtr)),
    ...relevantConfluence.map((zone) => zoneFromConfluence(zone, latestClose, latestAtr)),
  ].sort(compareZonePriority)

  return {
    latestClose,
    latestAtr,
    orderBlocks: relevantOrderBlocks,
    fairValueGaps: relevantGaps,
    liquidityZones: relevantLiquidity,
    balancePriceRanges: relevantBpr,
    confluenceZones: relevantConfluence,
    nearestSupport: zones.find((zone) => zone.top <= latestClose),
    nearestResistance: zones.find((zone) => zone.bottom >= latestClose),
    zones: zones.slice(0, Math.max(filter.maxZones, options.liquidity.maxVisible, options.bpr.maxVisible, options.confluenceZone.maxVisible)),
    filteredSummary: {
      orderBlocks: summarizeFilter(orderBlocks.length, relevantOrderBlocks.length, obReasons),
      fairValueGaps: summarizeFilter(fairValueGaps.length, relevantGaps.length, {
        ...fvgReasons,
        ...(filter.mergeOverlappingZones && filteredGaps.length > relevantGaps.length
          ? { merged_or_limited: filteredGaps.length - relevantGaps.length }
          : {}),
      }),
      liquidityZones: summarizeFilter(liquidityZones.length, relevantLiquidity.length, liqReasons),
      balancePriceRanges: summarizeFilter(balancePriceRanges.length, relevantBpr.length, bprReasons),
      confluenceZones: summarizeFilter(confluenceZones.length, relevantConfluence.length, confluenceReasons),
    },
  }
}

export function emptyRelevance(): TechnicalAnalysisRelevance {
  return {
    latestAtr: 0,
    orderBlocks: [],
    fairValueGaps: [],
    liquidityZones: [],
    balancePriceRanges: [],
    confluenceZones: [],
    zones: [],
    filteredSummary: {
      orderBlocks: summarizeFilter(0, 0, {}),
      fairValueGaps: summarizeFilter(0, 0, {}),
      liquidityZones: summarizeFilter(0, 0, {}),
      balancePriceRanges: summarizeFilter(0, 0, {}),
      confluenceZones: summarizeFilter(0, 0, {}),
    },
  }
}

export function summarizeFilter(raw: number, kept: number, reasons: Record<string, number>) {
  return {
    raw,
    kept,
    filtered: Math.max(0, raw - kept),
    reasons,
  }
}

export function reject(reasons: Record<string, number>, reason: string): false {
  reasons[reason] = (reasons[reason] ?? 0) + 1
  return false
}

export function isTooOld(index: number, latestIndex: number, maxAgeBars: number): boolean {
  return latestIndex - index > maxAgeBars
}

export function isTooFar(bottom: number, top: number, price: number, latestAtr: number, maxDistanceAtr: number): boolean {
  if (latestAtr <= 0) return false
  return zoneDistance(bottom, top, price) > latestAtr * maxDistanceAtr
}

export function isGapTooSmall(gap: FairValueGap, latestClose: number, latestAtr: number, filter: NormalizedTechnicalAnalysisZoneFilterOptions): boolean {
  const size = gap.top - gap.bottom
  const atrThreshold = latestAtr > 0 ? latestAtr * filter.minGapAtr : Number.POSITIVE_INFINITY
  const percentThreshold = latestClose > 0 ? latestClose * filter.minGapPercent : Number.POSITIVE_INFINITY
  return size < Math.min(atrThreshold, percentThreshold)
}

export function mergeFairValueGaps(gaps: FairValueGap[]): FairValueGap[] {
  const sorted = [...gaps].sort((a, b) =>
    a.direction.localeCompare(b.direction) || a.bottom - b.bottom || a.index - b.index)
  const merged: FairValueGap[] = []

  for (const gap of sorted) {
    const last = merged.at(-1)
    if (!last || last.direction !== gap.direction || last.mode !== gap.mode || gap.bottom > last.top) {
      merged.push({ ...gap, id: gap.id })
      continue
    }

    last.id = `${last.id}+${gap.id}`
    last.index = Math.max(last.index, gap.index)
    last.time = compareTime(last.time, gap.time) <= 0 ? gap.time : last.time
    last.leftIndex = Math.min(last.leftIndex, gap.leftIndex)
    last.leftTime = compareTime(last.leftTime, gap.leftTime) <= 0 ? last.leftTime : gap.leftTime
    last.top = Math.max(last.top, gap.top)
    last.bottom = Math.min(last.bottom, gap.bottom)
    last.midpoint = (last.top + last.bottom) / 2
    last.volumeConfirmation = strongerVolumeConfirmation(last.volumeConfirmation, gap.volumeConfirmation)
  }

  return merged.sort((a, b) => a.index - b.index)
}

export function zoneFromOrderBlock(block: OrderBlock, latestClose: number, latestAtr: number): TechnicalAnalysisRelevantZone {
  return {
    kind: 'order_block',
    id: block.id,
    direction: block.direction,
    index: block.index,
    time: block.time,
    top: block.top,
    bottom: block.bottom,
    midpoint: block.average,
    distance: zoneDistance(block.bottom, block.top, latestClose),
    distanceAtr: distanceAtr(block.bottom, block.top, latestClose, latestAtr),
    volumeConfirmation: block.volumeConfirmation,
    level: block.level,
    sourceStructureType: block.sourceStructureType,
    status: block.status === 'invalidated'
      ? 'invalidated'
      : block.status === 'breaker'
        ? 'mitigated'
        : block.status === 'retired'
          ? 'filled'
          : 'active',
  }
}

export function zoneFromFairValueGap(gap: FairValueGap, latestClose: number, latestAtr: number): TechnicalAnalysisRelevantZone {
  return {
    kind: 'fair_value_gap',
    id: gap.id,
    direction: gap.direction,
    index: gap.index,
    time: gap.time,
    top: gap.top,
    bottom: gap.bottom,
    midpoint: gap.midpoint,
    distance: zoneDistance(gap.bottom, gap.top, latestClose),
    distanceAtr: distanceAtr(gap.bottom, gap.top, latestClose, latestAtr),
    volumeConfirmation: gap.volumeConfirmation,
    status: gap.filled ? 'filled' : 'active',
    sourceIds: gap.id.includes('+') ? gap.id.split('+') : undefined,
  }
}

export function zoneFromLiquidity(zone: LiquidityZone, latestClose: number, latestAtr: number): TechnicalAnalysisRelevantZone {
  return {
    kind: 'liquidity',
    id: zone.id,
    direction: zone.direction,
    index: zone.index,
    time: zone.time,
    top: zone.top,
    bottom: zone.bottom,
    midpoint: zone.midpoint,
    distance: zoneDistance(zone.bottom, zone.top, latestClose),
    distanceAtr: distanceAtr(zone.bottom, zone.top, latestClose, latestAtr),
    volumeConfirmation: 'unavailable',
    status: zone.status,
  }
}

export function zoneFromBpr(zone: BalancePriceRange, latestClose: number, latestAtr: number): TechnicalAnalysisRelevantZone {
  return {
    kind: 'balance_price_range',
    id: zone.id,
    direction: zone.direction,
    index: zone.index,
    time: zone.time,
    top: zone.top,
    bottom: zone.bottom,
    midpoint: zone.midpoint,
    distance: zoneDistance(zone.bottom, zone.top, latestClose),
    distanceAtr: distanceAtr(zone.bottom, zone.top, latestClose, latestAtr),
    volumeConfirmation: 'unavailable',
    status: zone.status,
    sourceIds: [zone.bullishGapId, zone.bearishGapId],
  }
}

export function zoneFromConfluence(zone: ConfluenceZone, latestClose: number, latestAtr: number): TechnicalAnalysisRelevantZone {
  return {
    kind: 'confluence',
    id: zone.id,
    direction: zone.classification === 'resistance' ? 'bearish' : zone.classification === 'support' ? 'bullish' : 'bullish',
    index: zone.index,
    time: zone.time,
    top: zone.top,
    bottom: zone.bottom,
    midpoint: zone.midpoint,
    distance: zoneDistance(zone.bottom, zone.top, latestClose),
    distanceAtr: distanceAtr(zone.bottom, zone.top, latestClose, latestAtr),
    volumeConfirmation: 'unavailable',
    status: zone.status,
    sourceIds: zone.components,
  }
}

export function compareZonePriority(a: TechnicalAnalysisRelevantZone, b: TechnicalAnalysisRelevantZone): number {
  return a.distance - b.distance
    || volumeRank(b.volumeConfirmation) - volumeRank(a.volumeConfirmation)
    || levelRank(b.level) - levelRank(a.level)
    || b.index - a.index
}

export function zoneDistance(bottom: number, top: number, price: number): number {
  if (price < bottom) return bottom - price
  if (price > top) return price - top
  return 0
}

export function distanceAtr(bottom: number, top: number, price: number, latestAtr: number): number {
  if (latestAtr <= 0) return 0
  return round(zoneDistance(bottom, top, price) / latestAtr, 4)
}

export function volumeRank(value: 'confirmed' | 'weak' | 'unavailable'): number {
  if (value === 'confirmed') return 2
  if (value === 'weak') return 1
  return 0
}

export function strongerVolumeConfirmation(
  a: 'confirmed' | 'weak' | 'unavailable',
  b: 'confirmed' | 'weak' | 'unavailable',
): 'confirmed' | 'weak' | 'unavailable' {
  return volumeRank(a) >= volumeRank(b) ? a : b
}

export function levelRank(level?: PivotLevel): number {
  return level === 'swing' ? 2 : level === 'internal' ? 1 : 0
}
