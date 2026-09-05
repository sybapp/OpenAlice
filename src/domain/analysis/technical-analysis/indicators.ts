import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import { z } from 'zod'
import { parseBarDateUTC } from './order-flow/interval-time.js'
import { calculatePriceActionVolatility } from '@/domain/analysis/technical-analysis/price-action/indicators.js'
import type {
  MarketStructureAnalysis,
  StructureBreakEvent,
  StructureLevel,
  SwingPoint,
} from '@/domain/analysis/technical-analysis/price-action/types.js'

export type TechnicalAnalysisVwapAnchor = 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure'
export type TechnicalAnalysisVwapRelation = 'above' | 'below' | 'at' | 'unavailable'
export type TechnicalAnalysisEmaBias = 'bullish' | 'bearish' | 'mixed' | 'unavailable'
export type TechnicalAnalysisDirection = 'bullish' | 'bearish'

export interface TechnicalAnalysisIndicatorOptions {
  emaFastPeriod?: number
  emaSlowPeriod?: number
  emaLongPeriod?: number
  vwapEnabled?: boolean
  vwapAnchor?: 'auto' | TechnicalAnalysisVwapAnchor
  volumeLookback?: number
  fibEnabled?: boolean
  fibLevels?: number[]
  confluenceEnabled?: boolean
  confluenceMinFamilies?: number
  confluenceOverlapAtrMultiplier?: number
  maxConfluenceZones?: number
  atrPeriod?: number
}

export const technicalAnalysisIndicatorOptionsSchema: z.ZodType<TechnicalAnalysisIndicatorOptions> = z.object({
  emaFastPeriod: z.number().int().min(2).optional().describe('Fast EMA period (default 12)'),
  emaSlowPeriod: z.number().int().min(2).optional().describe('Slow EMA period (default 20)'),
  emaLongPeriod: z.number().int().min(2).optional().describe('Long EMA period (default 50)'),
  vwapEnabled: z.boolean().optional().describe('Include VWAP context (default true)'),
  vwapAnchor: z.enum(['auto', 'rolling', 'session', 'week', 'month', 'year', 'structure']).optional()
    .describe('VWAP anchor: auto, rolling, session, week, month, year, or structure (default auto)'),
  volumeLookback: z.number().int().min(2).optional()
    .describe('Rolling VWAP lookback and auto structure recency window (default 20)'),
  fibEnabled: z.boolean().optional().describe('Include structure-leg Fibonacci retracements (default true)'),
  fibLevels: z.array(z.number().gt(0).lt(1)).min(1).optional()
    .describe('Fibonacci ratios, for example [0.382, 0.5, 0.618, 0.786]'),
  confluenceEnabled: z.boolean().optional().describe('Include EMA/VWAP/Fibonacci confluence zones (default true)'),
  confluenceMinFamilies: z.union([z.literal(2), z.literal(3)]).optional()
    .describe('Minimum distinct families in a confluence zone (default 2)'),
  confluenceOverlapAtrMultiplier: z.number().positive().optional()
    .describe('ATR multiple used to group nearby indicator levels (default 0.25)'),
  maxConfluenceZones: z.number().int().min(1).max(50).optional()
    .describe('Maximum confluence zones (default 8)'),
  atrPeriod: z.number().int().min(2).optional().describe('ATR period for confluence grouping (default 200)'),
}).strict()

export interface TechnicalAnalysisIndicatorConfiguration {
  emaPeriods: {
    fast: number
    slow: number
    long: number
  }
  vwap: {
    enabled: boolean
    anchor: 'auto' | TechnicalAnalysisVwapAnchor
    volumeLookback: number
  }
  fib: {
    enabled: boolean
    levels: number[]
  }
  confluence: {
    enabled: boolean
    minFamilies: number
    overlapAtrMultiplier: number
    maxVisible: number
  }
  atrPeriod: number
}

export interface TechnicalAnalysisEmaContext {
  fast?: number
  slow?: number
  long?: number
  bias: TechnicalAnalysisEmaBias
}

export interface TechnicalAnalysisVwapContext {
  value?: number
  anchor?: TechnicalAnalysisVwapAnchor
  relation: TechnicalAnalysisVwapRelation
  /** Calendar anchors omitted because the loaded history does not reach their boundary. */
  incompleteAnchors?: TechnicalAnalysisVwapAnchor[]
  /** All computable anchors for comparison; value/anchor remain the selected primary. */
  anchors?: Partial<Record<TechnicalAnalysisVwapAnchor, { value: number; relation: TechnicalAnalysisVwapRelation }>>
}

export interface TechnicalAnalysisFibLevel {
  ratio: number
  price: number
  touched: boolean
  crossed: boolean
}

export interface TechnicalAnalysisFibRetracement {
  id: string
  direction: TechnicalAnalysisDirection
  level: StructureLevel
  eventIndex: number
  startIndex: number
  startTime: string
  startPrice: number
  endIndex: number
  endTime: string
  endPrice: number
  levels: TechnicalAnalysisFibLevel[]
  status: 'active' | 'broken'
}

export type TechnicalAnalysisConfluenceFamily = 'ema' | 'vwap' | 'fib'

export interface TechnicalAnalysisConfluence {
  score: number
  emaFast?: number
  emaSlow?: number
  emaLong?: number
  emaBias: TechnicalAnalysisEmaBias
  vwap?: number
  vwapAnchor?: TechnicalAnalysisVwapAnchor
  vwapRelation: TechnicalAnalysisVwapRelation
}

export interface TechnicalAnalysisConfluenceComponent {
  family: TechnicalAnalysisConfluenceFamily
  label: string
  price: number
}

export interface TechnicalAnalysisConfluenceZone {
  id: string
  index: number
  time: string
  top: number
  bottom: number
  midpoint: number
  families: TechnicalAnalysisConfluenceFamily[]
  components: TechnicalAnalysisConfluenceComponent[]
  strength: number
  classification: 'support' | 'resistance' | 'pivot'
  status: 'active'
}

export interface TechnicalAnalysisIndicatorResult {
  configuration: TechnicalAnalysisIndicatorConfiguration
  ema: TechnicalAnalysisEmaContext
  vwap?: TechnicalAnalysisVwapContext
  fibRetracements: TechnicalAnalysisFibRetracement[]
  confluence?: TechnicalAnalysisConfluence
  confluenceZones: TechnicalAnalysisConfluenceZone[]
  warnings: string[]
}

const DEFAULTS: Required<Pick<
  TechnicalAnalysisIndicatorConfiguration['emaPeriods'],
  'fast' | 'slow' | 'long'
>> & {
  vwapEnabled: boolean
  vwapAnchor: 'auto'
  volumeLookback: number
  fibEnabled: boolean
  fibLevels: number[]
  confluenceEnabled: boolean
  confluenceMinFamilies: number
  confluenceOverlapAtrMultiplier: number
  maxConfluenceZones: number
  atrPeriod: number
} = {
  fast: 12,
  slow: 20,
  long: 50,
  vwapEnabled: true,
  vwapAnchor: 'auto',
  volumeLookback: 20,
  fibEnabled: true,
  fibLevels: [0.382, 0.5, 0.618, 0.786],
  confluenceEnabled: true,
  confluenceMinFamilies: 2,
  confluenceOverlapAtrMultiplier: 0.25,
  maxConfluenceZones: 8,
  atrPeriod: 200,
}

function positiveInt(value: number | undefined, fallback: number, max = 1000): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.min(max, Math.max(2, Math.trunc(value)))
}

function positiveNumber(value: number | undefined, fallback: number, max = 10): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.min(max, Math.max(Number.EPSILON, value))
}

function normalizeOptions(options: TechnicalAnalysisIndicatorOptions = {}): TechnicalAnalysisIndicatorConfiguration {
  const periods = [
    positiveInt(options.emaFastPeriod, DEFAULTS.fast),
    positiveInt(options.emaSlowPeriod, DEFAULTS.slow),
    positiveInt(options.emaLongPeriod, DEFAULTS.long),
  ].sort((a, b) => a - b)
  const fibLevels = [...new Set(
    (options.fibLevels ?? DEFAULTS.fibLevels)
      .filter((level) => Number.isFinite(level) && level > 0 && level < 1)
      .map((level) => Math.round(level * 1000) / 1000),
  )].sort((a, b) => a - b)

  return {
    emaPeriods: {
      fast: periods[0] ?? DEFAULTS.fast,
      slow: periods[1] ?? DEFAULTS.slow,
      long: periods[2] ?? DEFAULTS.long,
    },
    vwap: {
      enabled: options.vwapEnabled ?? DEFAULTS.vwapEnabled,
      anchor: options.vwapAnchor ?? DEFAULTS.vwapAnchor,
      volumeLookback: positiveInt(options.volumeLookback, DEFAULTS.volumeLookback, 500),
    },
    fib: {
      enabled: options.fibEnabled ?? DEFAULTS.fibEnabled,
      levels: fibLevels.length > 0 ? fibLevels : [...DEFAULTS.fibLevels],
    },
    confluence: {
      enabled: options.confluenceEnabled ?? DEFAULTS.confluenceEnabled,
      minFamilies: options.confluenceMinFamilies === 3 ? 3 : 2,
      overlapAtrMultiplier: positiveNumber(
        options.confluenceOverlapAtrMultiplier,
        DEFAULTS.confluenceOverlapAtrMultiplier,
      ),
      maxVisible: positiveInt(options.maxConfluenceZones, DEFAULTS.maxConfluenceZones, 50),
    },
    atrPeriod: positiveInt(options.atrPeriod, DEFAULTS.atrPeriod),
  }
}

function round(value: number, precision = 6): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function typicalPrice(bar: OhlcvBar): number {
  return (bar.high + bar.low + bar.close) / 3
}

function hasUsableVolume(bar: OhlcvBar): boolean {
  return typeof bar.volume === 'number' && Number.isFinite(bar.volume) && bar.volume > 0
}

function emaSeries(bars: OhlcvBar[], period: number): number[] {
  if (bars.length === 0) return []
  const alpha = 2 / (period + 1)
  const values = [bars[0]!.close]
  for (let index = 1; index < bars.length; index += 1) {
    const close = Number.isFinite(bars[index]!.close) ? bars[index]!.close : values[index - 1]!
    values[index] = close * alpha + values[index - 1]! * (1 - alpha)
  }
  return values
}

function inferEmaBias(
  close: number,
  fast: number | undefined,
  slow: number | undefined,
  long: number | undefined,
): TechnicalAnalysisEmaBias {
  if (![close, fast, slow, long].every((value) => value !== undefined && Number.isFinite(value))) {
    return 'unavailable'
  }
  if (close >= fast! && fast! >= slow! && slow! >= long!) return 'bullish'
  if (close <= fast! && fast! <= slow! && slow! <= long!) return 'bearish'
  return 'mixed'
}

function dateFor(bar: OhlcvBar): Date | undefined {
  const timestamp = parseBarDateUTC(bar.date).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined
}

function sessionKey(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10)
  const timestamp = Date.parse(date)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : date
}

function weekKey(date: string): string {
  const parsed = dateFor({ date, open: 0, high: 0, low: 0, close: 0, volume: null })
  if (!parsed) return sessionKey(date)
  const value = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()))
  const day = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function monthKey(date: string): string {
  const parsed = dateFor({ date, open: 0, high: 0, low: 0, close: 0, volume: null })
  return parsed
    ? `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`
    : sessionKey(date)
}

function yearKey(date: string): string {
  const parsed = dateFor({ date, open: 0, high: 0, low: 0, close: 0, volume: null })
  return parsed ? String(parsed.getUTCFullYear()) : sessionKey(date)
}

function isIntraday(bars: OhlcvBar[]): boolean {
  const dateValues = bars
    .map((bar) => dateFor(bar)?.getTime())
    .filter((value): value is number => value !== undefined)
  if (dateValues.length < 2) return bars.some((bar) => /T|\d{2}:\d{2}/.test(bar.date))
  const deltas: number[] = []
  for (let index = 1; index < dateValues.length; index += 1) {
    const delta = Math.abs(dateValues[index]! - dateValues[index - 1]!)
    if (delta > 0) deltas.push(delta)
  }
  if (deltas.length === 0) return false
  deltas.sort((a, b) => a - b)
  return deltas[Math.floor(deltas.length / 2)]! < 86_400_000
}

function anchoredVwap(bars: OhlcvBar[], startIndex: number, endIndex: number): number {
  let priceVolume = 0
  let volume = 0
  for (let index = Math.max(0, startIndex); index <= endIndex; index += 1) {
    const bar = bars[index]!
    if (!hasUsableVolume(bar)) continue
    priceVolume += typicalPrice(bar) * bar.volume!
    volume += bar.volume!
  }
  return volume > 0 ? priceVolume / volume : Number.NaN
}

function anchoredByKey(
  bars: OhlcvBar[],
  index: number,
  keyFor: (date: string) => string,
  boundary: number,
): number {
  const key = keyFor(bars[index]!.date)
  let start = index
  while (start > 0 && keyFor(bars[start - 1]!.date) === key) start -= 1
  // A preceding period or a bar at the boundary proves that count did not
  // clip the anchor. Otherwise this is a window VWAP, not an anchored VWAP.
  if (start === 0 && parseBarDateUTC(bars[0]!.date).getTime() > boundary) return Number.NaN
  return anchoredVwap(bars, start, index)
}

function rollingVwap(bars: OhlcvBar[], index: number, lookback: number): number {
  return anchoredVwap(bars, Math.max(0, index - lookback + 1), index)
}

function structureVwap(
  bars: OhlcvBar[],
  index: number,
  events: StructureBreakEvent[],
): { value: number; anchorIndex?: number } {
  const event = [...events]
    .filter((candidate) => candidate.index <= index)
    .sort((a, b) => b.index - a.index)[0]
  if (!event) return { value: Number.NaN }
  return { value: anchoredVwap(bars, event.index, index), anchorIndex: event.index }
}

function vwapRelation(close: number, value: number): TechnicalAnalysisVwapRelation {
  if (!Number.isFinite(close) || !Number.isFinite(value)) return 'unavailable'
  const tolerance = Math.max(Math.abs(value) * 0.0005, 1e-6)
  if (close > value + tolerance) return 'above'
  if (close < value - tolerance) return 'below'
  return 'at'
}

function selectVwap(
  bars: OhlcvBar[],
  index: number,
  config: TechnicalAnalysisIndicatorConfiguration['vwap'],
  events: StructureBreakEvent[],
  history: OhlcvBar[],
): TechnicalAnalysisVwapContext {
  const bar = bars[index]!
  const provided = (bar as { vwap?: unknown }).vwap
  if (typeof provided === 'number' && Number.isFinite(provided)) {
    return {
      value: round(provided),
      anchor: 'session',
      relation: vwapRelation(bar.close, provided),
      anchors: { session: { value: round(provided), relation: vwapRelation(bar.close, provided) } },
    }
  }

  const rolling = rollingVwap(bars, index, config.volumeLookback)
  const date = parseBarDateUTC(bar.date)
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const boundaries = {
    session: dayStart,
    week: dayStart - ((date.getUTCDay() + 6) % 7) * 86_400_000,
    month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    year: Date.UTC(date.getUTCFullYear(), 0, 1),
  }
  const historyIndex = history.length - 1
  const session = anchoredByKey(history, historyIndex, sessionKey, boundaries.session)
  const week = anchoredByKey(history, historyIndex, weekKey, boundaries.week)
  const month = anchoredByKey(history, historyIndex, monthKey, boundaries.month)
  const year = anchoredByKey(history, historyIndex, yearKey, boundaries.year)
  const incompleteAnchors = (Object.keys(boundaries) as Array<keyof typeof boundaries>)
    .filter((anchor) => parseBarDateUTC(history[0]!.date).getTime() > boundaries[anchor])
  const structure = structureVwap(bars, index, events)
  const values: Record<TechnicalAnalysisVwapAnchor, number> = {
    rolling,
    session,
    week,
    month,
    year,
    structure: structure.value,
  }
  const anchors = Object.fromEntries(
    (Object.entries(values) as Array<[TechnicalAnalysisVwapAnchor, number]>)
      .filter(([, value]) => Number.isFinite(value))
      .map(([anchor, value]) => [anchor, { value: round(value), relation: vwapRelation(bar.close, value) }]),
  ) as TechnicalAnalysisVwapContext['anchors']

  const order: TechnicalAnalysisVwapAnchor[] = config.anchor === 'auto'
    ? structure.anchorIndex !== undefined && index - structure.anchorIndex <= config.volumeLookback * 2
      ? ['structure', ...(isIntraday(bars) ? ['session' as const] : []), 'week', 'month', 'year', 'rolling']
      : [...(isIntraday(bars) ? ['session' as const] : []), 'week', 'month', 'year', 'rolling', 'structure']
    : [config.anchor]

  for (const anchor of order) {
    const value = values[anchor]
    if (Number.isFinite(value)) {
      return {
        value: round(value),
        anchor,
        relation: vwapRelation(bar.close, value),
        anchors,
        incompleteAnchors,
      }
    }
  }
  return { relation: 'unavailable', anchors, incompleteAnchors }
}

function latestStructureEvent(marketStructure: MarketStructureAnalysis): StructureBreakEvent | undefined {
  const events = [...marketStructure.bos, ...marketStructure.choch].sort((a, b) => b.index - a.index)
  return events.find((event) => event.level === 'swing') ?? events[0]
}

function findFibStartPoint(
  marketStructure: MarketStructureAnalysis,
  event: StructureBreakEvent,
): SwingPoint | undefined {
  const points = marketStructure.swingPoints[event.level]
  const candidates = (event.type === 'bullish' ? points.lows : points.highs)
    .filter((point) => point.index < event.index && point.index <= event.brokenSwing.index)
    .sort((a, b) => b.index - a.index)
  return candidates[0] ?? (event.brokenSwing.type === (event.type === 'bullish' ? 'low' : 'high')
    ? event.brokenSwing
    : undefined)
}

function detectFibRetracements(
  bars: OhlcvBar[],
  marketStructure: MarketStructureAnalysis,
  config: TechnicalAnalysisIndicatorConfiguration['fib'],
): TechnicalAnalysisFibRetracement[] {
  if (!config.enabled || bars.length === 0) return []
  const event = latestStructureEvent(marketStructure)
  if (!event) return []
  const start = findFibStartPoint(marketStructure, event)
  if (!start) return []

  let endIndex = start.index
  let endPrice = event.type === 'bullish' ? bars[start.index]!.high : bars[start.index]!.low
  for (let index = start.index; index <= Math.min(event.index, bars.length - 1); index += 1) {
    if (event.type === 'bullish' && bars[index]!.high > endPrice) {
      endPrice = bars[index]!.high
      endIndex = index
    }
    if (event.type === 'bearish' && bars[index]!.low < endPrice) {
      endPrice = bars[index]!.low
      endIndex = index
    }
  }

  const range = Math.abs(endPrice - start.price)
  if (!Number.isFinite(range) || range <= 0) return []

  const levels = config.levels.map((ratio) => {
    const price = event.type === 'bullish'
      ? endPrice - range * ratio
      : endPrice + range * ratio
    let touched = false
    let crossed = false
    for (let index = Math.min(endIndex + 1, bars.length - 1); index < bars.length; index += 1) {
      if (bars[index]!.high >= price && bars[index]!.low <= price) touched = true
      if (event.type === 'bullish' && bars[index]!.close < price) crossed = true
      if (event.type === 'bearish' && bars[index]!.close > price) crossed = true
      if (crossed) break
    }
    return { ratio, price: round(price), touched, crossed }
  })
  const latestClose = bars.at(-1)!.close
  return [{
    id: `fib-${event.level}-${event.type}-${start.index}-${endIndex}`,
    direction: event.type,
    level: event.level,
    eventIndex: event.index,
    startIndex: start.index,
    startTime: bars[start.index]!.date,
    startPrice: round(start.price),
    endIndex,
    endTime: bars[endIndex]!.date,
    endPrice: round(endPrice),
    levels,
    status: event.type === 'bullish'
      ? latestClose < start.price ? 'broken' : 'active'
      : latestClose > start.price ? 'broken' : 'active',
  }]
}

function buildConfluence(
  bars: OhlcvBar[],
  ema: TechnicalAnalysisEmaContext,
  vwap: TechnicalAnalysisVwapContext | undefined,
): TechnicalAnalysisConfluence | undefined {
  if (!bars.length) return undefined
  const close = bars.at(-1)!.close
  const emaScore = ema.bias === 'bullish' ? 1 : ema.bias === 'bearish' ? -1 : 0
  const vwapScore = vwap?.relation === 'above' ? 0.5 : vwap?.relation === 'below' ? -0.5 : 0
  return {
    score: round(emaScore + vwapScore, 4),
    ...(ema.fast === undefined ? {} : { emaFast: round(ema.fast) }),
    ...(ema.slow === undefined ? {} : { emaSlow: round(ema.slow) }),
    ...(ema.long === undefined ? {} : { emaLong: round(ema.long) }),
    emaBias: ema.bias,
    ...(vwap?.value === undefined ? {} : { vwap: round(vwap.value) }),
    ...(vwap?.anchor === undefined ? {} : { vwapAnchor: vwap.anchor }),
    vwapRelation: vwap?.relation ?? 'unavailable',
  }
}

function buildConfluenceZones(
  bars: OhlcvBar[],
  fibRetracements: TechnicalAnalysisFibRetracement[],
  confluence: TechnicalAnalysisConfluence | undefined,
  config: TechnicalAnalysisIndicatorConfiguration,
  volatilityBars: OhlcvBar[] = bars,
): TechnicalAnalysisConfluenceZone[] {
  if (!config.confluence.enabled || !confluence || bars.length === 0) return []
  const latestIndex = bars.length - 1
  const latestClose = bars[latestIndex]!.close
  const volatility = calculatePriceActionVolatility(volatilityBars, config.atrPeriod).currentVolatility
  const tolerance = Math.max(volatility * config.confluence.overlapAtrMultiplier, 1e-6)
  const points: TechnicalAnalysisConfluenceComponent[] = []
  if (confluence.emaFast !== undefined) points.push({ family: 'ema', label: 'ema_fast', price: confluence.emaFast })
  if (confluence.emaSlow !== undefined) points.push({ family: 'ema', label: 'ema_slow', price: confluence.emaSlow })
  if (confluence.emaLong !== undefined) points.push({ family: 'ema', label: 'ema_long', price: confluence.emaLong })
  if (confluence.vwap !== undefined) {
    points.push({ family: 'vwap', label: `vwap_${confluence.vwapAnchor ?? 'auto'}`, price: confluence.vwap })
  }
  for (const retracement of fibRetracements.filter((item) => item.status === 'active')) {
    for (const level of retracement.levels) {
      points.push({ family: 'fib', label: `fib_${level.ratio}`, price: level.price })
    }
  }
  if (points.length < config.confluence.minFamilies) return []

  const groups: TechnicalAnalysisConfluenceComponent[][] = []
  for (const point of [...points].sort((a, b) => a.price - b.price)) {
    const current = groups.at(-1)
    const currentMidpoint = current && current.length > 0
      ? current.reduce((sum, item) => sum + item.price, 0) / current.length
      : Number.NaN
    if (current && Math.abs(point.price - currentMidpoint) <= tolerance) current.push(point)
    else groups.push([point])
  }

  return groups
    .map((group, index) => {
      const families = [...new Set(group.map((point) => point.family))]
      if (families.length < config.confluence.minFamilies) return undefined
      const top = Math.max(...group.map((point) => point.price))
      const bottom = Math.min(...group.map((point) => point.price))
      return {
        id: `confluence-${latestIndex}-${index}`,
        index: latestIndex,
        time: bars[latestIndex]!.date,
        top: round(top),
        bottom: round(bottom),
        midpoint: round((top + bottom) / 2),
        families,
        components: group,
        strength: families.length * 2 + group.length,
        classification: top < latestClose ? 'support' : bottom > latestClose ? 'resistance' : 'pivot',
        status: 'active' as const,
      }
    })
    .filter((zone): zone is TechnicalAnalysisConfluenceZone => zone !== undefined)
    .sort((a, b) => b.strength - a.strength || Math.abs(a.midpoint - latestClose) - Math.abs(b.midpoint - latestClose))
    .slice(0, config.confluence.maxVisible)
}

export function buildTechnicalAnalysisIndicators(
  bars: OhlcvBar[],
  marketStructure: MarketStructureAnalysis,
  options: TechnicalAnalysisIndicatorOptions = {},
  historyBars: OhlcvBar[] = bars,
): TechnicalAnalysisIndicatorResult {
  const configuration = normalizeOptions(options)
  const warnings: string[] = []
  const events = [...marketStructure.bos, ...marketStructure.choch]
  const periods = configuration.emaPeriods
  const fast = emaSeries(bars, periods.fast).at(-1)
  const slow = emaSeries(bars, periods.slow).at(-1)
  const long = emaSeries(bars, periods.long).at(-1)
  const latestClose = bars.at(-1)?.close
  const ema: TechnicalAnalysisEmaContext = {
    ...(fast === undefined || !Number.isFinite(fast) ? {} : { fast: round(fast) }),
    ...(slow === undefined || !Number.isFinite(slow) ? {} : { slow: round(slow) }),
    ...(long === undefined || !Number.isFinite(long) ? {} : { long: round(long) }),
    bias: inferEmaBias(latestClose ?? Number.NaN, fast, slow, long),
  }
  const vwap = configuration.vwap.enabled && bars.length > 0
    ? selectVwap(bars, bars.length - 1, configuration.vwap, events,
      historyBars.length >= bars.length && historyBars.at(-1)?.date === bars.at(-1)?.date ? historyBars : bars)
    : undefined
  if (vwap?.incompleteAnchors?.length) {
    warnings.push(`VWAP anchors unavailable because loaded history does not reach their boundary: ${vwap.incompleteAnchors.join(', ')}`)
  }
  if (configuration.vwap.enabled && !bars.some(hasUsableVolume)) {
    warnings.push('VWAP unavailable because the requested bars contain no positive volume')
  }
  const fibRetracements = detectFibRetracements(bars, marketStructure, configuration.fib)
  if (configuration.fib.enabled && bars.length > 0 && fibRetracements.length === 0) {
    warnings.push('Fibonacci retracement unavailable because no usable structure leg was detected')
  }
  const confluence = buildConfluence(bars, ema, vwap)
  const confluenceZones = buildConfluenceZones(bars, fibRetracements, confluence, configuration, historyBars)

  return {
    configuration,
    ema,
    ...(vwap === undefined ? {} : { vwap }),
    fibRetracements,
    ...(confluence === undefined ? {} : { confluence }),
    confluenceZones,
    warnings,
  }
}
