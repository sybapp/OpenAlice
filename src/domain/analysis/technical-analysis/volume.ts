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

import { anchoredVwap, avg, isIntradayCandles, latestPositiveAtr, meanVolumeBeforeIndex, monthKeyForTime, rollingVwap, round, selectVwapForIndex, sessionKeyForTime, sessionVwap, smoothSeries, standardDeviation, structureVwap, typicalPrice, volumeScore, weekKeyForTime, yearKeyForTime } from './helpers.js'
import { detectPivots } from './structure.js'
import { confluenceScoreForDirection } from './confluence.js'

export interface VwapDeviationResult {
  latest?: VwapDeviationContext
  signals: VolumePriceSignal[]
}

export function detectVolumeProfiles(
  candles: TechnicalAnalysisCandle[],
  options: NormalizedTechnicalAnalysisOptions,
  hasVolume: boolean,
): VolumeProfileSnapshot[] {
  if (!options.volumeProfile.enabled || !hasVolume || candles.length === 0) return []
  const latestIndex = candles.length - 1
  const latest = candles[latestIndex]
  const source = options.volumeProfile.mode === 'session'
    ? candles.filter((candle) => sessionKeyForTime(candle.time) === sessionKeyForTime(latest.time))
    : candles.slice(Math.max(0, candles.length - options.volumeProfile.lookback))
  if (source.length < 2) return []

  const low = Math.min(...source.map((candle) => candle.low))
  const high = Math.max(...source.map((candle) => candle.high))
  const range = high - low
  if (!Number.isFinite(range) || range <= 0) return []

  const bins = options.volumeProfile.bins
  const step = range / bins
  const raw = new Array<number>(bins).fill(0)
  for (const candle of source) {
    const volume = candle.volume
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0) continue
    const price = typicalPrice(candle)
    const idx = Math.max(0, Math.min(bins - 1, Math.floor((price - low) / step)))
    raw[idx] += volume
  }
  if (raw.every((value) => value <= 0)) return []

  const smooth = smoothSeries(raw, options.volumeProfile.smoothing)
  const maxVol = Math.max(...smooth)
  const totalVol = smooth.reduce((sum, value) => sum + value, 0)
  if (maxVol <= 0 || totalVol <= 0) return []
  const pocIdx = smooth.indexOf(maxVol)
  const pocPrice = low + step * pocIdx + step / 2

  const target = totalVol * (options.volumeProfile.valueAreaPercent / 100)
  let vaVolume = smooth[pocIdx]
  let up = pocIdx
  let dn = pocIdx
  while (vaVolume < target && (up < bins - 1 || dn > 0)) {
    const upVol = up < bins - 1 ? smooth[up + 1] : 0
    const dnVol = dn > 0 ? smooth[dn - 1] : 0
    if (upVol >= dnVol && up < bins - 1) {
      up += 1
      vaVolume += upVol
    } else if (dn > 0) {
      dn -= 1
      vaVolume += dnVol
    } else {
      break
    }
  }
  const vah = low + (up + 1) * step
  const val = low + dn * step

  const voidThreshold = maxVol * options.volumeProfile.voidThresholdRatio
  let voidStart = -1
  let longestStart = -1
  let longestEnd = -1
  for (let idx = 0; idx < bins; idx += 1) {
    if (smooth[idx] < voidThreshold) {
      if (voidStart === -1) voidStart = idx
      if (longestStart === -1 || idx - voidStart > longestEnd - longestStart) {
        longestStart = voidStart
        longestEnd = idx
      }
      continue
    }
    voidStart = -1
  }

  const midpoint = (low + high) / 2
  let upperVolume = 0
  let lowerVolume = 0
  for (let idx = 0; idx < bins; idx += 1) {
    const center = low + idx * step + step / 2
    if (center >= midpoint) upperVolume += smooth[idx]
    else lowerVolume += smooth[idx]
  }
  const upperPercent = totalVol > 0 ? (upperVolume / totalVol) * 100 : 0
  const lowerPercent = totalVol > 0 ? (lowerVolume / totalVol) * 100 : 0

  return [{
    id: `vp-${options.volumeProfile.mode}-${latestIndex}`,
    index: latestIndex,
    time: latest.time,
    mode: options.volumeProfile.mode,
    anchorKey: options.volumeProfile.mode === 'session'
      ? sessionKeyForTime(latest.time)
      : `rolling:${Math.max(0, candles.length - source.length)}-${latestIndex}`,
    lookback: source.length,
    bins,
    valueAreaPercent: options.volumeProfile.valueAreaPercent,
    pocPrice: round(pocPrice, 6),
    vah: round(vah, 6),
    val: round(val, 6),
    ...(longestStart >= 0 && longestEnd >= longestStart ? {
      voidTop: round(low + (longestEnd + 1) * step, 6),
      voidBottom: round(low + longestStart * step, 6),
      voidMidpoint: round(low + (longestStart + longestEnd + 1) * step / 2, 6),
    } : {}),
    upperVolume: round(upperVolume, 4),
    lowerVolume: round(lowerVolume, 4),
    upperPercent: round(upperPercent, 4),
    lowerPercent: round(lowerPercent, 4),
    skewRatio: round(upperVolume / Math.max(lowerVolume, 1e-9), 6),
  }]
}

export function detectStopZones(
  candles: TechnicalAnalysisCandle[],
  options: NormalizedTechnicalAnalysisOptions,
  hasVolume: boolean,
): StopZone[] {
  if (!options.stopZone.enabled || candles.length === 0) return []
  const pivots = detectPivots(candles, options.stopZone.pivotLookback, 'swing')
  if (pivots.length === 0) return []
  const highs = pivots.filter((pivot) => pivot.kind === 'high').slice(-options.stopZone.maxActive)
  const lows = pivots.filter((pivot) => pivot.kind === 'low').slice(-options.stopZone.maxActive)
  const zones: StopZone[] = []

  for (const pivot of [...highs, ...lows]) {
    const side: StopZone['side'] = pivot.kind === 'high' ? 'upper' : 'lower'
    const direction: TechnicalAnalysisDirection = side === 'upper' ? 'bearish' : 'bullish'
    const zone: StopZone = {
      id: `stop-${side}-${pivot.index}`,
      side,
      direction,
      index: pivot.index,
      time: pivot.time,
      price: pivot.price,
      status: 'active',
    }
    if (hasVolume) {
      for (let index = pivot.index + 1; index < candles.length; index += 1) {
        const candle = candles[index]
        const crossed = side === 'upper' ? candle.high >= pivot.price : candle.low <= pivot.price
        if (!crossed) continue
        const mean = meanVolumeBeforeIndex(candles, index, 20)
        const volume = candles[index].volume
        if (!Number.isFinite(mean) || typeof volume !== 'number' || !Number.isFinite(volume) || mean <= 0) continue
        if (volume < mean * options.stopZone.volumeMultiplier) continue
        zone.status = 'triggered'
        zone.triggerIndex = index
        zone.triggerTime = candle.time
        zone.triggerScore = volumeScore(candles, index, options.volumeLookback)
        break
      }
    }
    zones.push(zone)
  }

  return zones
    .sort((a, b) => a.index - b.index)
    .slice(-options.stopZone.maxActive)
}

export function detectVwapDeviation(
  candles: TechnicalAnalysisCandle[],
  events: StructureEvent[],
  options: NormalizedTechnicalAnalysisOptions,
): VwapDeviationResult {
  if (!options.vwapDeviation.enabled || candles.length === 0) return { signals: [] }
  const intraday = isIntradayCandles(candles)
  const rolling = rollingVwap(candles, options.volumeLookback)
  const session = sessionVwap(candles)
  const week = anchoredVwap(candles, weekKeyForTime)
  const month = anchoredVwap(candles, monthKeyForTime)
  const year = anchoredVwap(candles, yearKeyForTime)
  const structure = structureVwap(candles, events)
  const selected = candles.map((_, index) =>
    selectVwapForIndex(candles, index, options.vwapAnchor, intraday, rolling, session, week, month, year, structure, events, options.volumeLookback))
  const signals: VolumePriceSignal[] = []
  let latest: VwapDeviationContext | undefined

  for (let index = 0; index < candles.length; index += 1) {
    const context = selected[index]
    if (!Number.isFinite(context.value)) continue
    const start = Math.max(0, index - options.vwapDeviation.bandLookback + 1)
    const deltas: number[] = []
    for (let i = start; i <= index; i += 1) {
      const vwapValue = selected[i]?.value
      if (!Number.isFinite(vwapValue)) continue
      deltas.push(candles[i].close - vwapValue)
    }
    if (deltas.length < 2) continue
    const sigma = standardDeviation(deltas)
    if (!Number.isFinite(sigma) || sigma <= 0) continue

    const vwap = context.value
    const upper = vwap + sigma * options.vwapDeviation.stdDevMultiplier
    const lower = vwap - sigma * options.vwapDeviation.stdDevMultiplier
    const close = candles[index].close
    const sigmaDistance = (close - vwap) / sigma
    const relation: VwapDeviationContext['relation'] = close > upper
      ? 'above_upper'
      : close < lower
        ? 'below_lower'
        : 'inside'
    latest = {
      index,
      time: candles[index].time,
      anchor: context.anchor,
      vwap: round(vwap, 6),
      upper: round(upper, 6),
      lower: round(lower, 6),
      sigmaDistance: round(sigmaDistance, 4),
      relation,
    }
    if (!options.vwapDeviation.signalEnabled || relation === 'inside') continue
    signals.push({
      id: `vwap-dev-${index}-${relation}`,
      index,
      time: candles[index].time,
      kind: 'vwap_deviation',
      direction: relation === 'above_upper' ? 'bullish' : 'bearish',
      score: round(Math.abs(sigmaDistance), 4),
      message: relation === 'above_upper'
        ? `Price stretched above VWAP band (${context.anchor ?? 'auto'}).`
        : `Price stretched below VWAP band (${context.anchor ?? 'auto'}).`,
    })
  }

  return { latest, signals }
}

export function detectUnusualVolumeSignals(
  candles: TechnicalAnalysisCandle[],
  options: NormalizedTechnicalAnalysisOptions,
  hasVolume: boolean,
): VolumePriceSignal[] {
  if (!options.unusualVolume.enabled || !hasVolume || candles.length === 0) return []
  const signals: VolumePriceSignal[] = []
  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index].volume
    if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) continue
    const start = Math.max(0, index - options.unusualVolume.baselineLookback)
    const window = candles.slice(start, index)
      .map((candle) => candle.volume)
      .filter((volume): volume is number => typeof volume === 'number' && Number.isFinite(volume) && volume > 0)
    if (window.length < 2) continue
    const mean = avg(window)
    if (!Number.isFinite(mean) || mean <= 0) continue
    const sigma = standardDeviation(window)
    const z = sigma > 0 ? (current - mean) / sigma : current > mean ? 1 : 0
    const rvol = current / mean
    if (z < options.unusualVolume.zScoreThreshold || rvol < options.unusualVolume.rvolThreshold) continue
    const candle = candles[index]
    const direction = candle.close > candle.open ? 'bullish' : candle.close < candle.open ? 'bearish' : undefined
    signals.push({
      id: `unusual-volume-${index}`,
      index,
      time: candle.time,
      kind: 'unusual_volume',
      direction,
      score: round(z, 4),
      message: `Unusual volume spike detected (z=${round(z, 2)}, rvol=${round(rvol, 2)}x).`,
    })
  }
  return signals
}

export function buildVolumePriceSignals(
  candles: TechnicalAnalysisCandle[],
  events: StructureEvent[],
  orderBlocks: OrderBlock[],
  gaps: FairValueGap[],
  liquidityZones: LiquidityZone[],
  balancePriceRanges: BalancePriceRange[],
  volumeProfiles: VolumeProfileSnapshot[],
  stopZones: StopZone[],
  vwapDeviationSignals: VolumePriceSignal[],
  unusualVolumeSignals: VolumePriceSignal[],
  options: NormalizedTechnicalAnalysisOptions,
  hasVolume: boolean,
  confluenceByIndex: Array<TechnicalAnalysisConfluence | undefined>,
): VolumePriceSignal[] {
  const signals: VolumePriceSignal[] = []

  if (hasVolume) {
    for (const event of events) {
      const score = volumeScore(candles, event.index, options.volumeLookback)
      const confluence = confluenceByIndex[event.index]
      const confluenceScore = confluenceScoreForDirection(confluence, event.direction)
      signals.push({
        id: `${event.id}:volume`,
        index: event.index,
        time: event.time,
        kind: score >= 1 ? 'breakout_confirmation' : 'weak_breakout',
        direction: event.direction,
        score,
        ...(confluence ? { confluence, confluenceScore } : {}),
        message: score >= 1
          ? `${event.type} has above-average breakout volume.`
          : `${event.type} has weak or average breakout volume; watch for fake-breakout risk.`,
      })
    }

    for (const block of orderBlocks.filter((block) => block.mitigated)) {
      const score = block.mitigationIndex === undefined ? 0 : volumeScore(candles, block.mitigationIndex, options.volumeLookback)
      const signalIndex = block.mitigationIndex ?? block.index
      const confluence = confluenceByIndex[signalIndex]
      const confluenceScore = confluenceScoreForDirection(confluence, block.direction)
      signals.push({
        id: `${block.id}:retest`,
        index: signalIndex,
        time: block.mitigationTime ?? block.time,
        kind: 'ob_retest',
        direction: block.direction,
        score,
        ...(confluence ? { confluence, confluenceScore } : {}),
        message: score >= 1 ? 'Order block retest has volume participation.' : 'Order block retest lacks strong volume confirmation.',
      })
    }

    for (const gap of gaps.filter((gap) => gap.filled)) {
      const score = gap.fillIndex === undefined ? 0 : volumeScore(candles, gap.fillIndex, options.volumeLookback)
      const signalIndex = gap.fillIndex ?? gap.index
      const confluence = confluenceByIndex[signalIndex]
      const confluenceScore = confluenceScoreForDirection(confluence, gap.direction)
      signals.push({
        id: `${gap.id}:fill`,
        index: signalIndex,
        time: gap.fillTime ?? gap.time,
        kind: 'fvg_fill',
        direction: gap.direction,
        score,
        ...(confluence ? { confluence, confluenceScore } : {}),
        message: score >= 1 ? 'FVG fill happened with strong opposite participation.' : 'FVG fill happened without strong volume confirmation.',
      })
    }

    for (const zone of liquidityZones) {
      if (zone.status !== 'swept' || zone.sweepIndex === undefined) continue
      const sweepIndex = zone.sweepIndex
      const score = volumeScore(candles, sweepIndex, options.volumeLookback)
      const confluence = confluenceByIndex[sweepIndex]
      const confluenceScore = confluenceScoreForDirection(confluence, zone.direction)
      signals.push({
        id: `${zone.id}:sweep`,
        index: sweepIndex,
        time: zone.sweepTime ?? zone.time,
        kind: 'liquidity_sweep',
        direction: zone.direction,
        score,
        ...(confluence ? { confluence, confluenceScore } : {}),
        message: `${zone.side} liquidity was swept.`,
      })
    }

    for (const range of balancePriceRanges) {
      if (range.status !== 'broken' || range.breakIndex === undefined) continue
      const breakIndex = range.breakIndex
      const score = volumeScore(candles, breakIndex, options.volumeLookback)
      const direction: TechnicalAnalysisDirection = candles[breakIndex].close > range.top ? 'bullish' : 'bearish'
      const confluence = confluenceByIndex[breakIndex]
      const confluenceScore = confluenceScoreForDirection(confluence, direction)
      signals.push({
        id: `${range.id}:broken`,
        index: breakIndex,
        time: range.breakTime ?? range.time,
        kind: 'bpr_touch',
        direction,
        score,
        ...(confluence ? { confluence, confluenceScore } : {}),
        message: 'Balance price range broke.',
      })
    }
  }

  for (const gap of gaps.filter((gap) => gap.mode === 'IFVG')) {
    const confluence = confluenceByIndex[gap.index]
    const confluenceScore = confluenceScoreForDirection(confluence, gap.direction)
    signals.push({
      id: `${gap.id}:ifvg`,
      index: gap.index,
      time: gap.time,
      kind: 'ifvg_inversion',
      direction: gap.direction,
      score: hasVolume ? volumeScore(candles, gap.index, options.volumeLookback) : 0,
      ...(confluence ? { confluence, confluenceScore } : {}),
      message: `${gap.direction} IFVG inversion formed.`,
    })
  }

  for (const zone of stopZones.filter((zone) => zone.status === 'triggered' && zone.triggerIndex !== undefined)) {
    const triggerIndex = zone.triggerIndex!
    const confluence = confluenceByIndex[triggerIndex]
    const confluenceScore = confluenceScoreForDirection(confluence, zone.direction)
    signals.push({
      id: `${zone.id}:trigger`,
      index: triggerIndex,
      time: zone.triggerTime ?? zone.time,
      kind: 'stop_run',
      direction: zone.direction,
      score: zone.triggerScore ?? (hasVolume ? volumeScore(candles, triggerIndex, options.volumeLookback) : 0),
      ...(confluence ? { confluence, confluenceScore } : {}),
      message: `${zone.side} stop zone triggered with elevated volume.`,
    })
  }

  const latestClose = candles.at(-1)?.close
  const latestAtr = latestPositiveAtr(candles, options.atrPeriod)
  for (const profile of volumeProfiles) {
    if (latestClose === undefined || !Number.isFinite(latestClose)) continue
    const tolerance = Math.max(latestAtr * 0.1, Math.abs(latestClose) * 0.0005, 1e-6)
    if (Math.abs(latestClose - profile.pocPrice) <= tolerance) {
      signals.push({
        id: `${profile.id}:poc`,
        index: profile.index,
        time: profile.time,
        kind: 'vp_level',
        score: 0.5,
        message: 'Price is interacting with volume-profile POC.',
      })
    }
    if (latestClose > profile.vah) {
      signals.push({
        id: `${profile.id}:vah-break`,
        index: profile.index,
        time: profile.time,
        kind: 'vp_level',
        direction: 'bullish',
        score: round((latestClose - profile.vah) / Math.max(latestAtr, 1e-6), 4),
        message: 'Price is above VAH (value-area high).',
      })
    } else if (latestClose < profile.val) {
      signals.push({
        id: `${profile.id}:val-break`,
        index: profile.index,
        time: profile.time,
        kind: 'vp_level',
        direction: 'bearish',
        score: round((profile.val - latestClose) / Math.max(latestAtr, 1e-6), 4),
        message: 'Price is below VAL (value-area low).',
      })
    }
    if (profile.voidTop !== undefined && profile.voidBottom !== undefined && latestClose >= profile.voidBottom && latestClose <= profile.voidTop) {
      signals.push({
        id: `${profile.id}:void`,
        index: profile.index,
        time: profile.time,
        kind: 'vp_level',
        score: 0.5,
        message: 'Price is inside the widest low-volume void.',
      })
    }
  }

  signals.push(...vwapDeviationSignals)
  signals.push(...unusualVolumeSignals)
  const deduped = new Map<string, VolumePriceSignal>()
  for (const signal of signals) deduped.set(signal.id, signal)
  return [...deduped.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
}
