import type { OhlcvData } from '@/domains/technical-analysis/indicator-kit/index'
import type { BarFeatureSummary, BarType, BrooksMidpointAvoidance, BrooksNoTradeReason } from '../types'

export function summarizeBarFeatures(bar: OhlcvData): BarFeatureSummary {
  const tr = bar.high - bar.low
  const body = Math.abs(bar.close - bar.open)
  const bodyPct = tr === 0 ? 0 : body / tr
  return { tr, body, bodyPct }
}

export function classifyBarTypeFromFeatures(bar: OhlcvData, features: BarFeatureSummary): BarType {
  const { tr, bodyPct } = features

  if (tr === 0) return 'doji'
  if (bodyPct < 0.2) return 'doji'
  return bar.close >= bar.open ? 'bull' : 'bear'
}

export function classifyBarType(bar: OhlcvData): BarType {
  return classifyBarTypeFromFeatures(bar, summarizeBarFeatures(bar))
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function highestHigh(bars: OhlcvData[]): number | null {
  if (bars.length === 0) return null
  return Math.max(...bars.map((bar) => bar.high))
}

export function lowestLow(bars: OhlcvData[]): number | null {
  if (bars.length === 0) return null
  return Math.min(...bars.map((bar) => bar.low))
}

export function averageTrueRange(bars: OhlcvData[], period = 14): number {
  if (bars.length === 0) return 0
  const slice = bars.slice(-period)
  const sum = slice.reduce((acc, bar) => acc + (bar.high - bar.low), 0)
  return sum / slice.length
}

export function countDirectionalBars(bars: OhlcvData[]): { bull: number; bear: number; doji: number } {
  return bars.reduce((acc, bar) => {
    const type = classifyBarType(bar)
    acc[type] += 1
    return acc
  }, { bull: 0, bear: 0, doji: 0 })
}

/**
 * Midpoint avoidance (simplified / deterministic):
 * If the latest bar close is too close to the midpoint of its own range,
 * mark no-trade. This is a conservative proxy for "midpoint magnets".
 */
export function checkMidpointAvoidance(params: {
  bars: OhlcvData[]
  avoidance: BrooksMidpointAvoidance
}): BrooksNoTradeReason[] {
  const { bars, avoidance } = params
  if (!avoidance.enabled) return []
  if (bars.length === 0) return []

  const last = bars[bars.length - 1]
  const { tr } = summarizeBarFeatures(last)
  if (tr === 0) return []

  const mid = (last.high + last.low) / 2
  const dist = Math.abs(last.close - mid)
  const distPct = dist / tr

  if (distPct < avoidance.band) {
    return [{
      code: 'TR_MIDPOINT',
      message: 'No-trade: price too close to true-range midpoint (midpoint avoidance).',
      details: { distPct, band: avoidance.band, mid, close: last.close, tr },
    }]
  }

  return []
}
