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

import { atr, averageRange, avg, classifyVolume, compareTime, round } from './helpers.js'

export function detectOrderBlocks(
  candles: TechnicalAnalysisCandle[],
  events: StructureEvent[],
  options: NormalizedTechnicalAnalysisOptions,
): OrderBlock[] {
  const blocks: OrderBlock[] = []
  for (const event of events) {
    if (!passesObFilter(event.type, options.obFilter)) continue

    const source = findOrderBlockSource(candles, event, options)
    if (source === undefined) continue
    const { top, bottom } = priceZoneFromSource(candles[source], event.direction, options.obPosition)
    const average = (top + bottom) / 2
    const ob: OrderBlock = {
      id: `${event.id}:ob`,
      direction: event.direction,
      level: event.level,
      sourceStructureId: event.id,
      sourceStructureType: event.type,
      index: event.index,
      time: event.time,
      leftIndex: source,
      leftTime: candles[source].time,
      top,
      bottom,
      average,
      sourceVolume: candles[source].volume ?? null,
      mitigated: false,
      invalidated: false,
      status: 'active',
      volumeConfirmation: event.volumeConfirmation,
    }

    applyOrderBlockLifecycle(candles, ob, options)
    blocks.unshift(ob)
  }

  const kept = blocks.slice(0, options.maxOrderBlocks)
  const totalVolume = kept.reduce((sum, block) => sum + (block.sourceVolume ?? 0), 0)
  for (const block of kept) {
    block.relativeVolumeShare = totalVolume > 0 && block.sourceVolume ? round((block.sourceVolume / totalVolume) * 100, 2) : undefined
  }
  return kept.reverse()
}

export function detectFairValueGaps(
  candles: TechnicalAnalysisCandle[],
  options: NormalizedTechnicalAnalysisOptions,
  hasVolume: boolean,
): FairValueGap[] {
  if (options.fvgMode === 'IFVG') {
    const baseFvg: FairValueGap[] = []
    for (let index = 2; index < candles.length; index += 1) {
      const prev2 = candles[index - 2]
      const prev1 = candles[index - 1]
      const current = candles[index]
      const gap = buildGap(prev2, prev1, current, index, 'FVG')
      if (!gap) continue
      gap.volumeConfirmation = hasVolume ? classifyVolume(candles, index, options.volumeLookback) : 'unavailable'
      baseFvg.push(gap)
    }
    const inversions = detectIfvgInversions(candles, baseFvg, options, hasVolume)
    for (const gap of inversions) applyFairValueGapLifecycle(candles, gap)
    return inversions
  }

  const gaps: FairValueGap[] = []
  for (let index = 2; index < candles.length; index += 1) {
    const prev2 = candles[index - 2]
    const prev1 = candles[index - 1]
    const current = candles[index]
    const gap = buildGap(prev2, prev1, current, index, options.fvgMode)
    if (!gap) continue
    gap.volumeConfirmation = hasVolume ? classifyVolume(candles, index, options.volumeLookback) : 'unavailable'
    gaps.push(gap)
  }

  for (const gap of gaps) applyFairValueGapLifecycle(candles, gap)

  return gaps
}

export function detectIfvgInversions(
  candles: TechnicalAnalysisCandle[],
  source: FairValueGap[],
  options: NormalizedTechnicalAnalysisOptions,
  hasVolume: boolean,
): FairValueGap[] {
  const inversions: FairValueGap[] = []
  for (const gap of source) {
    for (let index = gap.index + 1; index < candles.length; index += 1) {
      const candle = candles[index]
      const inverted = gap.direction === 'bullish'
        ? candle.close < gap.bottom
        : candle.close > gap.top
      if (!inverted) continue
      const direction: TechnicalAnalysisDirection = gap.direction === 'bullish' ? 'bearish' : 'bullish'
      inversions.push({
        id: `ifvg-${direction}-${gap.index}-${index}`,
        direction,
        mode: 'IFVG',
        index,
        time: candle.time,
        leftIndex: gap.leftIndex,
        leftTime: gap.leftTime,
        top: gap.top,
        bottom: gap.bottom,
        midpoint: gap.midpoint,
        filled: false,
        status: 'active',
        volumeConfirmation: hasVolume ? classifyVolume(candles, index, options.volumeLookback) : 'unavailable',
      })
      break
    }
  }
  return inversions
}

export function applyFairValueGapLifecycle(candles: TechnicalAnalysisCandle[], gap: FairValueGap): void {
  for (let index = gap.index + 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const touched = gap.direction === 'bullish' ? candle.low < gap.top : candle.high > gap.bottom
    if (touched && gap.status === 'active') {
      gap.status = 'broken'
      gap.breakIndex = index
      gap.breakTime = candle.time
    }
    const filled = gap.direction === 'bullish' ? candle.close < gap.bottom : candle.close > gap.top
    if (filled) {
      gap.filled = true
      gap.fillIndex = index
      gap.fillTime = candle.time
      gap.status = 'filled'
      return
    }
  }
}

export function detectLiquidityZones(
  candles: TechnicalAnalysisCandle[],
  pivots: PricePivot[],
  options: NormalizedTechnicalAnalysisOptions,
): LiquidityZone[] {
  if (!options.liquidity.enabled || pivots.length === 0) return []
  const atrValues = atr(candles, options.atrPeriod)
  const groups: Array<{
    side: 'buyside' | 'sellside'
    sourceIndexes: number[]
    sourceTimes: Array<string | number>
    prices: number[]
  }> = []

  for (const pivot of pivots) {
    const side = pivot.kind === 'high' ? 'buyside' : 'sellside'
    const pivotAtr = atrValues[pivot.index] ?? averageRange(candles)
    const tolerance = pivotAtr * options.liquidity.atrMargin
    const group = groups.find((entry) =>
      entry.side === side && Math.abs(avg(entry.prices) - pivot.price) <= tolerance)
    if (group) {
      group.sourceIndexes.push(pivot.index)
      group.sourceTimes.push(pivot.time)
      group.prices.push(pivot.price)
    } else {
      groups.push({
        side,
        sourceIndexes: [pivot.index],
        sourceTimes: [pivot.time],
        prices: [pivot.price],
      })
    }
  }

  const zones: LiquidityZone[] = groups
    .filter((entry) => entry.sourceIndexes.length >= options.liquidity.minClusterSize)
    .map((entry) => {
      const top = Math.max(...entry.prices)
      const bottom = Math.min(...entry.prices)
      const lastIndex = Math.max(...entry.sourceIndexes)
      const zone: LiquidityZone = {
        id: `liq-${entry.side}-${entry.sourceIndexes[0]}-${lastIndex}`,
        side: entry.side,
        direction: entry.side === 'buyside' ? 'bearish' : 'bullish',
        index: lastIndex,
        time: entry.sourceTimes[entry.sourceTimes.length - 1],
        sourceIndexes: entry.sourceIndexes,
        top,
        bottom,
        midpoint: (top + bottom) / 2,
        status: 'active',
      }
      applyLiquidityLifecycle(candles, zone)
      return zone
    })
    .sort((a, b) => a.index - b.index)

  return zones.slice(-options.liquidity.maxVisible)
}

export function detectBalancePriceRanges(
  candles: TechnicalAnalysisCandle[],
  gaps: FairValueGap[],
  options: NormalizedTechnicalAnalysisBprOptions,
): BalancePriceRange[] {
  if (!options.enabled) return []
  const bullish = gaps.filter((gap) => gap.direction === 'bullish')
  const bearish = gaps.filter((gap) => gap.direction === 'bearish')
  const ranges: BalancePriceRange[] = []

  for (let i = bullish.length - 1; i >= 0; i -= 1) {
    for (let j = bearish.length - 1; j >= 0; j -= 1) {
      const bl = bullish[i]
      const br = bearish[j]
      const top = Math.min(bl.top, br.top)
      const bottom = Math.max(bl.bottom, br.bottom)
      if (top <= bottom) continue
      const lastIndex = Math.max(bl.index, br.index)
      const lastCandle = candles[lastIndex] ?? candles.at(-1)
      const range: BalancePriceRange = {
        id: `bpr-${bl.id}-${br.id}`,
        direction: (lastCandle?.close ?? 0) >= (top + bottom) / 2 ? 'bullish' : 'bearish',
        index: lastIndex,
        time: lastCandle?.time ?? bl.time,
        top,
        bottom,
        midpoint: (top + bottom) / 2,
        bullishGapId: bl.id,
        bearishGapId: br.id,
        status: 'active',
      }
      applyBprLifecycle(candles, range)
      ranges.push(range)
      if (ranges.length >= options.maxVisible) return ranges.sort((a, b) => a.index - b.index)
    }
  }
  return ranges.sort((a, b) => a.index - b.index)
}

export function findOrderBlockSource(candles: TechnicalAnalysisCandle[], event: StructureEvent, options: NormalizedTechnicalAnalysisOptions): number | undefined {
  const from = Math.max(0, event.brokenPivot.index)
  const to = Math.max(from, event.index - 1)
  let best = from
  for (let index = from; index <= to; index += 1) {
    if (event.direction === 'bullish') {
      if (candles[index].low < candles[best].low) best = index
    } else if (candles[index].high > candles[best].high) {
      best = index
    }
  }

  if (options.obPosition === 'Full') {
    return [...Array(to - from + 1).keys()].map((offset) => from + offset).reverse().find((index) =>
      event.direction === 'bullish' ? candles[index].close < candles[index].open : candles[index].close > candles[index].open,
    ) ?? best
  }
  return best
}

export function priceZoneFromSource(candle: TechnicalAnalysisCandle, direction: TechnicalAnalysisDirection, position: NormalizedTechnicalAnalysisOptions['obPosition']) {
  const bodyMid = (candle.open + candle.close) / 2
  const rangeMid = (candle.high + candle.low) / 2
  if (position === 'Full') return { top: candle.high, bottom: candle.low }
  if (position === 'Middle') {
    return direction === 'bullish'
      ? { top: bodyMid, bottom: candle.low }
      : { top: candle.high, bottom: bodyMid }
  }
  if (position === 'Accurate') {
    return direction === 'bullish'
      ? { top: rangeMid, bottom: candle.low }
      : { top: candle.high, bottom: rangeMid }
  }
  return direction === 'bullish'
    ? { top: Math.min(rangeMid, Math.max(candle.open, candle.close)), bottom: candle.low }
    : { top: candle.high, bottom: Math.max(rangeMid, Math.min(candle.open, candle.close)) }
}

export function applyOrderBlockLifecycle(candles: TechnicalAnalysisCandle[], block: OrderBlock, options: NormalizedTechnicalAnalysisOptions): void {
  const target = options.obMitigation === 'Middle' ? block.average : block.direction === 'bullish' ? block.bottom : block.top
  for (let index = block.index + 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const touched = block.direction === 'bullish'
      ? candle.low <= block.top && candle.high >= block.bottom
      : candle.high >= block.bottom && candle.low <= block.top
    if (touched && !block.mitigated) {
      block.mitigated = true
      block.mitigationIndex = index
      block.mitigationTime = candle.time
      block.status = 'breaker'
    }
    const invalidated = block.direction === 'bullish' ? candle.close < target : candle.close > target
    if (invalidated) {
      block.invalidated = true
      block.mitigated = true
      block.mitigationIndex = block.mitigationIndex ?? index
      block.mitigationTime = block.mitigationTime ?? candle.time
      block.breakIndex = index
      block.breakTime = candle.time
      block.status = 'invalidated'
      return
    }
    const retired = block.direction === 'bullish' ? candle.close > block.top : candle.close < block.bottom
    if (retired && block.status === 'breaker') {
      block.status = 'retired'
      block.breakIndex = block.breakIndex ?? index
      block.breakTime = block.breakTime ?? candle.time
      return
    }
  }
}

export function applyLiquidityLifecycle(candles: TechnicalAnalysisCandle[], zone: LiquidityZone): void {
  for (let index = zone.index + 1; index < candles.length; index += 1) {
    const candle = candles[index]
    if (zone.side === 'buyside') {
      if (zone.status === 'active' && candle.high > zone.bottom) zone.status = 'partially_swept'
      if (candle.high > zone.top) {
        zone.status = 'swept'
        zone.sweepIndex = index
        zone.sweepTime = candle.time
        return
      }
      continue
    }
    if (zone.status === 'active' && candle.low < zone.top) zone.status = 'partially_swept'
    if (candle.low < zone.bottom) {
      zone.status = 'swept'
      zone.sweepIndex = index
      zone.sweepTime = candle.time
      return
    }
  }
}

export function applyBprLifecycle(candles: TechnicalAnalysisCandle[], range: BalancePriceRange): void {
  for (let index = range.index + 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const broken = candle.close < range.bottom || candle.close > range.top
    if (!broken) continue
    range.status = 'broken'
    range.breakIndex = index
    range.breakTime = candle.time
    return
  }
}

export function buildGap(
  prev2: TechnicalAnalysisCandle,
  prev1: TechnicalAnalysisCandle,
  current: TechnicalAnalysisCandle,
  index: number,
  mode: NormalizedTechnicalAnalysisOptions['fvgMode'],
): FairValueGap | null {
  let bullish = false
  let bearish = false
  let top = 0
  let bottom = 0
  let leftCandle = prev1

  if (mode === 'FVG') {
    bullish = current.low > prev2.high
    bearish = current.high < prev2.low
    top = bullish ? current.low : prev2.low
    bottom = bullish ? prev2.high : current.high
    leftCandle = prev2
  } else if (mode === 'OG') {
    bullish = current.low > prev1.high
    bearish = current.high < prev1.low
    top = bullish ? current.low : prev1.low
    bottom = bullish ? prev1.high : current.high
  } else if (mode === 'VI') {
    const prevBodyHigh = Math.max(prev1.open, prev1.close)
    const prevBodyLow = Math.min(prev1.open, prev1.close)
    const bodyHigh = Math.max(current.open, current.close)
    const bodyLow = Math.min(current.open, current.close)
    bullish = current.open > prev1.close && prev1.high > current.low && current.close > prev1.close && current.open > prev1.open && prev1.high < bodyLow
    bearish = current.open < prev1.close && prev1.low < current.high && current.close < prev1.close && current.open < prev1.open && prev1.low > bodyHigh
    top = bullish ? bodyLow : prevBodyHigh
    bottom = bullish ? prevBodyHigh : bodyHigh
    if (bullish) bottom = prevBodyHigh
    if (bearish) top = prevBodyLow
  } else {
    return null
  }

  if (!bullish && !bearish) return null
  const direction: TechnicalAnalysisDirection = bullish ? 'bullish' : 'bearish'
  const finalTop = Math.max(top, bottom)
  const finalBottom = Math.min(top, bottom)
  return {
    id: `${mode.toLowerCase()}-${direction}-${index}`,
    direction,
    mode,
    index,
    time: current.time,
    leftIndex: leftCandle === prev2 ? index - 2 : index - 1,
    leftTime: leftCandle.time,
    top: finalTop,
    bottom: finalBottom,
    midpoint: (finalTop + finalBottom) / 2,
    filled: false,
    status: 'active',
    volumeConfirmation: 'unavailable',
  }
}

export function passesObFilter(type: StructureEvent['type'], filter: NormalizedTechnicalAnalysisOptions['obFilter']): boolean {
  return filter === 'None' || filter === type
}
