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

export function classifyVolume(candles: TechnicalAnalysisCandle[], index: number, lookback: number): 'confirmed' | 'weak' | 'unavailable' {
  const score = volumeScore(candles, index, lookback)
  if (!Number.isFinite(score)) return 'unavailable'
  return score >= 1 ? 'confirmed' : 'weak'
}

export function volumeScore(candles: TechnicalAnalysisCandle[], index: number, lookback: number): number {
  const current = candles[index]?.volume
  if (typeof current !== 'number' || !Number.isFinite(current)) return Number.NaN
  const start = Math.max(0, index - lookback)
  const values = candles.slice(start, index)
    .map((candle) => candle.volume)
    .filter((volume): volume is number => typeof volume === 'number' && Number.isFinite(volume))
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const stdev = Math.sqrt(variance)
  if (stdev === 0) return current > mean ? 1 : 0
  return round((current - mean) / stdev, 4)
}

export function ema(candles: TechnicalAnalysisCandle[], period: number): number[] {
  const values: number[] = []
  if (candles.length === 0) return values
  const alpha = 2 / (period + 1)
  values[0] = candles[0].close
  for (let index = 1; index < candles.length; index += 1) {
    values[index] = candles[index].close * alpha + values[index - 1] * (1 - alpha)
  }
  return values
}

export function rollingVwap(candles: TechnicalAnalysisCandle[], lookback: number): number[] {
  const values: number[] = new Array(candles.length).fill(Number.NaN)
  for (let index = 0; index < candles.length; index += 1) {
    const start = Math.max(0, index - lookback + 1)
    let pv = 0
    let volume = 0
    for (let j = start; j <= index; j += 1) {
      const candleVolume = candles[j].volume
      if (typeof candleVolume !== 'number' || !Number.isFinite(candleVolume) || candleVolume <= 0) continue
      pv += typicalPrice(candles[j]) * candleVolume
      volume += candleVolume
    }
    values[index] = volume > 0 ? pv / volume : Number.NaN
  }
  return values
}

export function sessionVwap(candles: TechnicalAnalysisCandle[]): number[] {
  const values: number[] = new Array(candles.length).fill(Number.NaN)
  let lastKey = ''
  let pv = 0
  let volume = 0
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const key = sessionKeyForTime(candle.time)
    if (index === 0 || key !== lastKey) {
      pv = 0
      volume = 0
      lastKey = key
    }
    const candleVolume = candle.volume
    if (typeof candleVolume === 'number' && Number.isFinite(candleVolume) && candleVolume > 0) {
      pv += typicalPrice(candle) * candleVolume
      volume += candleVolume
    }
    values[index] = volume > 0 ? pv / volume : Number.NaN
  }
  return values
}

export function anchoredVwap(candles: TechnicalAnalysisCandle[], keyFn: (time: string | number) => string): number[] {
  const values: number[] = new Array(candles.length).fill(Number.NaN)
  let lastKey = ''
  let pv = 0
  let volume = 0
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const key = keyFn(candle.time)
    if (index === 0 || key !== lastKey) {
      pv = 0
      volume = 0
      lastKey = key
    }
    const candleVolume = candle.volume
    if (typeof candleVolume === 'number' && Number.isFinite(candleVolume) && candleVolume > 0) {
      pv += typicalPrice(candle) * candleVolume
      volume += candleVolume
    }
    values[index] = volume > 0 ? pv / volume : Number.NaN
  }
  return values
}

export function structureVwap(candles: TechnicalAnalysisCandle[], events: StructureEvent[]): number[] {
  const values: number[] = new Array(candles.length).fill(Number.NaN)
  if (events.length === 0) return values
  const sortedEvents = [...events].sort((a, b) => a.index - b.index)
  let eventCursor = 0
  let anchorIndex = sortedEvents[0].index
  let pv = 0
  let volume = 0

  for (let index = 0; index < candles.length; index += 1) {
    while (eventCursor + 1 < sortedEvents.length && sortedEvents[eventCursor + 1].index <= index) {
      eventCursor += 1
      anchorIndex = sortedEvents[eventCursor].index
      pv = 0
      volume = 0
    }
    if (index < anchorIndex) continue

    const candleVolume = candles[index].volume
    if (typeof candleVolume === 'number' && Number.isFinite(candleVolume) && candleVolume > 0) {
      pv += typicalPrice(candles[index]) * candleVolume
      volume += candleVolume
    }
    values[index] = volume > 0 ? pv / volume : Number.NaN
  }
  return values
}

export function selectVwapForIndex(
  candles: TechnicalAnalysisCandle[],
  index: number,
  anchorMode: NormalizedTechnicalAnalysisOptions['vwapAnchor'],
  intraday: boolean,
  rolling: number[] | undefined,
  session: number[] | undefined,
  week: number[] | undefined,
  month: number[] | undefined,
  year: number[] | undefined,
  structure: number[] | undefined,
  events: StructureEvent[],
  lookback: number,
): { value: number, anchor?: 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure' } {
  if (!rolling && !session && !week && !month && !year && !structure) return { value: Number.NaN }
  const candleVwap = candles[index].vwap
  if (typeof candleVwap === 'number' && Number.isFinite(candleVwap)) return { value: candleVwap, anchor: 'session' }

  const byAnchor = {
    rolling: rolling?.[index] ?? Number.NaN,
    session: session?.[index] ?? Number.NaN,
    week: week?.[index] ?? Number.NaN,
    month: month?.[index] ?? Number.NaN,
    year: year?.[index] ?? Number.NaN,
    structure: structure?.[index] ?? Number.NaN,
  }

  if (anchorMode !== 'auto') {
    const value = byAnchor[anchorMode]
    return Number.isFinite(value) ? { value, anchor: anchorMode } : firstFiniteVwap(byAnchor, ['rolling', 'session', 'week', 'month', 'year', 'structure'])
  }

  const recentStructure = latestStructureDistance(events, index)
  if (Number.isFinite(byAnchor.structure) && recentStructure !== undefined && recentStructure <= lookback * 2) {
    return { value: byAnchor.structure, anchor: 'structure' }
  }

  if (intraday && Number.isFinite(byAnchor.session)) return { value: byAnchor.session, anchor: 'session' }
  if (Number.isFinite(byAnchor.week)) return { value: byAnchor.week, anchor: 'week' }
  if (Number.isFinite(byAnchor.month)) return { value: byAnchor.month, anchor: 'month' }
  if (Number.isFinite(byAnchor.year)) return { value: byAnchor.year, anchor: 'year' }
  if (Number.isFinite(byAnchor.rolling)) return { value: byAnchor.rolling, anchor: 'rolling' }
  if (Number.isFinite(byAnchor.session)) return { value: byAnchor.session, anchor: 'session' }
  if (Number.isFinite(byAnchor.structure)) return { value: byAnchor.structure, anchor: 'structure' }

  return { value: Number.NaN }
}

export function firstFiniteVwap(
  byAnchor: Record<'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure', number>,
  order: Array<'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure'>,
): { value: number, anchor?: 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure' } {
  for (const anchor of order) {
    if (Number.isFinite(byAnchor[anchor])) return { value: byAnchor[anchor], anchor }
  }
  return { value: Number.NaN }
}

export function latestStructureDistance(events: StructureEvent[], index: number): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].index <= index) return index - events[i].index
  }
  return undefined
}

export function inferEmaBias(close: number, fast: number, slow: number, long: number): TechnicalAnalysisConfluence['emaBias'] {
  if (!Number.isFinite(close) || !Number.isFinite(fast) || !Number.isFinite(slow) || !Number.isFinite(long)) return 'unavailable'
  if (close >= fast && fast >= slow && slow >= long) return 'bullish'
  if (close <= fast && fast <= slow && slow <= long) return 'bearish'
  return 'mixed'
}

export function vwapRelation(close: number, vwap: number): TechnicalAnalysisConfluence['vwapRelation'] {
  if (!Number.isFinite(close) || !Number.isFinite(vwap)) return 'unavailable'
  const tolerance = Math.max(Math.abs(vwap) * 0.0005, 1e-6)
  if (close > vwap + tolerance) return 'above'
  if (close < vwap - tolerance) return 'below'
  return 'at'
}

export function isIntradayCandles(candles: TechnicalAnalysisCandle[]): boolean {
  const sample = candles
    .map((candle) => candle.time)
    .slice(0, Math.min(candles.length, 12))
  if (sample.some((time) => typeof time === 'string' && time.includes('T'))) return true
  if (sample.every((time) => typeof time === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(time))) return false

  const numeric = candles
    .map((candle) => typeof candle.time === 'number' && Number.isFinite(candle.time) ? candle.time : Number.NaN)
    .filter((value) => Number.isFinite(value))
  if (numeric.length < 2) return false
  const deltas: number[] = []
  for (let i = 1; i < numeric.length; i += 1) {
    const delta = Math.abs(numeric[i] - numeric[i - 1])
    if (delta > 0 && Number.isFinite(delta)) deltas.push(delta)
  }
  if (deltas.length === 0) return false
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return median < 86_400_000
}

export function sessionKeyForTime(time: string | number): string {
  if (typeof time === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(time)) return time.slice(0, 10)
    const parsed = Date.parse(time)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
    return time
  }
  if (typeof time === 'number' && Number.isFinite(time)) {
    const epochMs = time > 1e12 ? time : time > 1e10 ? time * 1000 : Number.NaN
    if (Number.isFinite(epochMs)) return new Date(epochMs).toISOString().slice(0, 10)
  }
  return String(time)
}

export function weekKeyForTime(time: string | number): string {
  const date = timeToDate(time)
  if (!date) return sessionKeyForTime(time)
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = utcDate.getUTCDay() || 7
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${utcDate.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function monthKeyForTime(time: string | number): string {
  const date = timeToDate(time)
  if (!date) return sessionKeyForTime(time)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function yearKeyForTime(time: string | number): string {
  const date = timeToDate(time)
  if (!date) return sessionKeyForTime(time)
  return String(date.getUTCFullYear())
}

export function timeToDate(time: string | number): Date | undefined {
  if (typeof time === 'string') {
    const parsed = Date.parse(time)
    return Number.isFinite(parsed) ? new Date(parsed) : undefined
  }
  if (typeof time === 'number' && Number.isFinite(time)) {
    const epochMs = time > 1e12 ? time : time > 1e10 ? time * 1000 : Number.NaN
    return Number.isFinite(epochMs) ? new Date(epochMs) : undefined
  }
  return undefined
}

export function typicalPrice(candle: TechnicalAnalysisCandle): number {
  return (candle.high + candle.low + candle.close) / 3
}

export function avg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0
  const mean = avg(values)
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function meanVolumeBeforeIndex(candles: TechnicalAnalysisCandle[], index: number, lookback: number): number {
  const start = Math.max(0, index - lookback)
  const values = candles.slice(start, index)
    .map((candle) => candle.volume)
    .filter((volume): volume is number => typeof volume === 'number' && Number.isFinite(volume) && volume > 0)
  return values.length === 0 ? Number.NaN : avg(values)
}

export function smoothSeries(values: number[], radius: number): number[] {
  if (radius <= 0) return [...values]
  const out = new Array<number>(values.length).fill(0)
  for (let index = 0; index < values.length; index += 1) {
    let sum = 0
    let weightSum = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const idx = index + offset
      if (idx < 0 || idx >= values.length) continue
      const weight = 1 / (1 + Math.abs(offset))
      sum += values[idx] * weight
      weightSum += weight
    }
    out[index] = weightSum > 0 ? sum / weightSum : values[index]
  }
  return out
}

export function atr(candles: TechnicalAnalysisCandle[], period: number): number[] {
  const values: number[] = []
  const trueRanges: number[] = []
  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index]
    const prev = candles[index - 1]
    const tr = prev
      ? Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close))
      : current.high - current.low
    trueRanges[index] = tr
    if (index < period) {
      values[index] = meanRange(trueRanges, 0, index + 1)
    } else if (index === period) {
      values[index] = meanRange(trueRanges, 1, period + 1)
    } else {
      values[index] = (values[index - 1] * (period - 1) + tr) / period
    }
  }
  return values
}

export function meanRange(values: number[], start: number, end: number): number {
  let sum = 0
  for (let index = start; index < end; index += 1) {
    sum += values[index]
  }
  return sum / (end - start)
}

export function averageRange(candles: TechnicalAnalysisCandle[]): number {
  if (candles.length === 0) return 0
  return candles.reduce((sum, candle) => sum + (candle.high - candle.low), 0) / candles.length
}

export function compareTime(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

export function pivotKey(pivot: PricePivot): string {
  return `${pivot.level}:${pivot.kind}:${pivot.index}`
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function round(value: number, precision: number): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

export function latestPositiveAtr(candles: TechnicalAnalysisCandle[], period: number): number {
  const values = atr(candles, period)
  const latest = [...values].reverse().find((value) => value > 0 && Number.isFinite(value))
  return latest ?? averageRange(candles)
}
