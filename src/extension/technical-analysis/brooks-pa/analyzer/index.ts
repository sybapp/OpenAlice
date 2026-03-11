import type { OhlcvData } from '@/extension/technical-analysis/indicator-kit/index'
import type {
  BrooksDecisionWindowSummary,
  BrooksFrame,
  BrooksMidpointAvoidance,
  BrooksPaAnalyzeOutput,
  BrooksStructureSignal,
  RecentBar,
  Timeframes,
} from '../types'
import {
  averageTrueRange,
  checkMidpointAvoidance,
  classifyBarType,
  countDirectionalBars,
  highestHigh,
  lowestLow,
  round,
  summarizeBarFeatures,
} from './features'

function approximatelyEqual(a: number | null, b: number | null, tolerance: number): boolean {
  if (a == null || b == null) return false
  return Math.abs(a - b) <= tolerance
}

function clampConfidence(value: number): number {
  return Math.max(0.05, Math.min(0.95, round(value, 2)))
}

function toRecentBars(bars: OhlcvData[], recentBars: number): RecentBar[] {
  return bars.slice(-recentBars).map((bar, i, arr): RecentBar => {
    const index = bars.length - arr.length + i
    return {
      index,
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      barType: classifyBarType(bar),
      features: summarizeBarFeatures(bar),
    }
  })
}

export function loadBrooksContext(params: {
  symbol: string
  timeframes: Timeframes
  lookbackBars: number
  recentBars: number
  midpointAvoidance: BrooksMidpointAvoidance
  dataByTf: Record<string, OhlcvData[]>
}) {
  const { symbol, timeframes, lookbackBars, recentBars, midpointAvoidance, dataByTf } = params
  return {
    symbol,
    timeframes,
    lookbackBars,
    recentBars,
    midpointAvoidance,
    dataByTf,
  }
}

export function buildBrooksFrames(context: ReturnType<typeof loadBrooksContext>): Record<string, BrooksFrame> {
  return Object.fromEntries(Object.values(context.timeframes).map((tf) => {
    const bars = context.dataByTf[tf] ?? []
    const recent = toRecentBars(bars, context.recentBars)
    return [tf, {
      tf,
      bars: recent,
      latestIndex: bars.length - 1,
      latestClose: bars.length ? bars[bars.length - 1].close : null,
      rangeHigh: highestHigh(bars.slice(-context.recentBars)),
      rangeLow: lowestLow(bars.slice(-context.recentBars)),
    } satisfies BrooksFrame]
  }))
}

function detectSecondEntryDirection(bars: OhlcvData[]): 'long' | 'short' | null {
  if (bars.length < 4) return null
  const a = bars[bars.length - 4]
  const b = bars[bars.length - 3]
  const c = bars[bars.length - 2]
  const d = bars[bars.length - 1]
  if (a.close > a.open && b.close < b.open && c.close < c.open && d.close > d.open && d.close > c.high) {
    return 'long'
  }
  if (a.close < a.open && b.close > b.open && c.close > c.open && d.close < d.open && d.close < c.low) {
    return 'short'
  }
  return null
}

function detectWedgeDirection(bars: OhlcvData[]): 'bull' | 'bear' | null {
  if (bars.length < 6) return null
  let upPushes = 0
  let downPushes = 0
  for (let i = bars.length - 6; i < bars.length - 1; i++) {
    const curr = bars[i]
    const next = bars[i + 1]
    if (next.high > curr.high && next.close <= curr.high) upPushes += 1
    if (next.low < curr.low && next.close >= curr.low) downPushes += 1
  }
  if (upPushes >= 3) return 'bear'
  if (downPushes >= 3) return 'bull'
  return null
}

export function detectBrooksStructure(params: {
  timeframes: Timeframes
  dataByTf: Record<string, OhlcvData[]>
}): Record<string, BrooksStructureSignal> {
  const { timeframes, dataByTf } = params
  const results: Record<string, BrooksStructureSignal> = {}

  for (const tf of Object.values(timeframes)) {
    const bars = dataByTf[tf] ?? []
    const recent = bars.slice(-20)
    if (recent.length < 5) {
      results[tf] = { tf, direction: 'neutral', marketType: 'unknown', confidence: 0.2 }
      continue
    }

    const first = recent[0]
    const last = recent[recent.length - 1]
    const prev = recent.slice(0, -1)
    const move = last.close - first.close
    const windowHigh = highestHigh(recent) ?? last.high
    const windowLow = lowestLow(recent) ?? last.low
    const range = Math.max(windowHigh - windowLow, 1e-9)
    const atr = Math.max(averageTrueRange(recent, 14), 1e-9)
    const directional = countDirectionalBars(recent)
    const trendScore = Math.abs(move) / range
    const sameSideShare = Math.max(directional.bull, directional.bear) / recent.length
    const breakoutUp = last.close > (highestHigh(prev) ?? last.close)
    const breakoutDown = last.close < (lowestLow(prev) ?? last.close)
    const followThrough = recent.length >= 2
      && Math.sign(recent[recent.length - 1].close - recent[recent.length - 1].open) !== 0
      && Math.sign(recent[recent.length - 1].close - recent[recent.length - 1].open)
        === Math.sign(recent[recent.length - 2].close - recent[recent.length - 2].open)
      && Math.abs(recent[recent.length - 1].close - recent[recent.length - 1].open) > atr * 0.4
    const failedBreakout = recent.length >= 2 && ((
      recent[recent.length - 2].close > (highestHigh(recent.slice(0, -2)) ?? recent[recent.length - 2].close)
      && last.close < recent[recent.length - 2].low
    ) || (
      recent[recent.length - 2].close < (lowestLow(recent.slice(0, -2)) ?? recent[recent.length - 2].close)
      && last.close > recent[recent.length - 2].high
    ))
    const secondEntry = detectSecondEntryDirection(recent)
    const wedge = detectWedgeDirection(recent)
    const channel = trendScore > 0.45 && sameSideShare >= 0.55
      ? (move >= 0 ? 'bull' : 'bear')
      : null

    let marketType: BrooksStructureSignal['marketType'] = 'unknown'
    let direction: BrooksStructureSignal['direction'] = 'neutral'
    let breakoutDirection: BrooksStructureSignal['breakoutDirection']
    let confidence = 0.25

    if (breakoutUp || breakoutDown) {
      marketType = 'breakout'
      direction = breakoutUp ? 'long' : 'short'
      breakoutDirection = breakoutUp ? 'up' : 'down'
      confidence = 0.65 + (followThrough ? 0.15 : 0) - (failedBreakout ? 0.2 : 0)
    } else if (trendScore > 0.55 && sameSideShare >= 0.6) {
      marketType = channel ? 'channel' : 'trend'
      direction = move >= 0 ? 'long' : 'short'
      confidence = 0.55 + Math.min(0.2, trendScore * 0.2)
    } else if (trendScore < 0.3) {
      marketType = 'range'
      direction = 'neutral'
      confidence = 0.55
    }

    results[tf] = {
      tf,
      direction,
      marketType,
      confidence: clampConfidence(confidence),
      breakoutDirection,
      followThrough,
      failedBreakout,
      secondEntry,
      channel,
      wedge,
    }
  }

  return results
}

export function buildBrooksLevels(params: {
  timeframes: Timeframes
  dataByTf: Record<string, OhlcvData[]>
}) {
  const levels: BrooksPaAnalyzeOutput['levels'] = []
  const keyBars: BrooksPaAnalyzeOutput['keyBars'] = []

  for (const tf of Object.values(params.timeframes)) {
    const bars = params.dataByTf[tf] ?? []
    if (bars.length === 0) continue
    const recent = bars.slice(-20)
    const high = highestHigh(recent)
    const low = lowestLow(recent)
    const last = bars[bars.length - 1]
    const tolerance = Math.max((high != null && low != null ? high - low : 0) * 0.001, 1e-9)
    if (high != null) levels.push({ tf, kind: 'resistance', price: round(high), note: 'Recent 20-bar high' })
    if (low != null) levels.push({ tf, kind: 'support', price: round(low), note: 'Recent 20-bar low' })
    levels.push({ tf, kind: 'close', price: round(last.close), note: 'Latest close' })

    const breakoutIndex = recent.findIndex((bar) => approximatelyEqual(bar.close, high, tolerance) || approximatelyEqual(bar.close, low, tolerance))
    if (breakoutIndex >= 0) {
      const bar = recent[breakoutIndex]
      keyBars.push({
        tf,
        index: bars.length - recent.length + breakoutIndex,
        date: bar.date,
        note: approximatelyEqual(bar.close, high, tolerance) ? 'Recent breakout candidate high close' : 'Recent breakout candidate low close',
      })
    }
  }

  return { levels, keyBars }
}

export function summarizeBrooksDecisionWindow(params: {
  tf: string
  bars: OhlcvData[]
  recentBars: number
}): BrooksDecisionWindowSummary {
  const recent = toRecentBars(params.bars, params.recentBars)
  const bullBars = recent.filter((bar) => bar.barType === 'bull').length
  const bearBars = recent.filter((bar) => bar.barType === 'bear').length
  const dojiBars = recent.filter((bar) => bar.barType === 'doji').length
  const rangeHigh = recent.length ? Math.max(...recent.map((bar) => bar.high)) : null
  const rangeLow = recent.length ? Math.min(...recent.map((bar) => bar.low)) : null
  const latestClose = recent.length ? recent[recent.length - 1].close : null
  const firstOpen = recent.length ? recent[0].open : null
  const tolerance = Math.max(rangeHigh != null && rangeLow != null ? (rangeHigh - rangeLow) * 0.001 : 0, 1e-9)
  const breakoutState = recent.length >= 2 && rangeHigh != null && rangeLow != null
    ? approximatelyEqual(latestClose, rangeHigh, tolerance)
      ? 'up'
      : approximatelyEqual(latestClose, rangeLow, tolerance)
        ? 'down'
        : 'inside'
    : 'inside'
  const notes: string[] = []
  if (bullBars > bearBars) notes.push('Bull bodies dominate the decision window.')
  if (bearBars > bullBars) notes.push('Bear bodies dominate the decision window.')
  if (dojiBars >= Math.ceil(recent.length / 3)) notes.push('Decision window contains many doji / overlap bars.')
  if (breakoutState === 'up') notes.push('Latest close sits at the recent decision-window high.')
  if (breakoutState === 'down') notes.push('Latest close sits at the recent decision-window low.')

  return {
    tf: params.tf,
    bars: recent,
    summary: {
      barCount: recent.length,
      bullBars,
      bearBars,
      dojiBars,
      netChange: firstOpen == null || latestClose == null ? 0 : round(latestClose - firstOpen),
      rangeHigh,
      rangeLow,
      latestClose,
      dominantSide: bullBars === bearBars ? 'balanced' : bullBars > bearBars ? 'bull' : 'bear',
      breakoutState,
      notes,
    },
  }
}

export function analyzeBrooksPa(params: {
  symbol: string
  timeframes: Timeframes
  lookbackBars: number
  recentBars: number
  midpointAvoidance: BrooksMidpointAvoidance
  dataByTf: Record<string, OhlcvData[]>
}): BrooksPaAnalyzeOutput {
  const context = loadBrooksContext(params)
  const frames = buildBrooksFrames(context)
  const structureByTf = detectBrooksStructure({ timeframes: context.timeframes, dataByTf: context.dataByTf })
  const { levels, keyBars } = buildBrooksLevels({ timeframes: context.timeframes, dataByTf: context.dataByTf })

  const execTf = context.timeframes.execution
  const execBars = context.dataByTf[execTf] ?? []
  const latestIndex = execBars.length - 1
  const noTrade = checkMidpointAvoidance({ bars: execBars, avoidance: context.midpointAvoidance })
  const decisionWindow = summarizeBrooksDecisionWindow({ tf: execTf, bars: execBars, recentBars: context.recentBars })

  const patterns: BrooksPaAnalyzeOutput['patterns'] = []
  const tradeCandidates: BrooksPaAnalyzeOutput['tradeCandidates'] = []
  const marketTypeByTf: BrooksPaAnalyzeOutput['marketTypeByTf'] = {}

  for (const tf of Object.values(context.timeframes)) {
    const signal = structureByTf[tf]
    marketTypeByTf[tf] = { marketType: signal.marketType, confidence: signal.confidence }
    if (signal.followThrough) patterns.push({ tf, name: 'follow-through', note: `${tf} has consecutive same-direction strength bars.` })
    if (signal.failedBreakout) patterns.push({ tf, name: 'failed-breakout', note: `${tf} failed to hold a prior break.` })
    if (signal.wedge) patterns.push({ tf, name: 'wedge', note: `${signal.wedge} wedge pressure detected.` })
    if (signal.secondEntry) patterns.push({ tf, name: 'second-entry', note: `${signal.secondEntry} second-entry style setup detected.` })
    if (signal.marketType === 'range') patterns.push({ tf, name: 'range', note: `${tf} is trading inside overlap / balance.` })
    if (signal.marketType === 'breakout') patterns.push({ tf, name: 'breakout', note: `${tf} is pushing ${signal.breakoutDirection}.` })
    if (signal.direction !== 'neutral' && !signal.failedBreakout) {
      tradeCandidates.push({
        tf,
        direction: signal.direction,
        rationale: `${tf} ${signal.marketType} structure with confidence ${signal.confidence}${signal.followThrough ? ' and follow-through' : ''}.`,
      })
    }
  }

  return {
    indexing: { oldest: 0, latest: latestIndex },
    marketTypeByTf,
    levels,
    patterns,
    tradeCandidates,
    noTrade,
    recentBars: frames[execTf]?.bars ?? [],
    keyBars,
    decisionWindow,
  }
}
