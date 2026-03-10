import type { OhlcvData } from '@/extension/indicator-kit/index'
import type { BarFeatureSummary, BarType, BrooksMidpointAvoidance, BrooksNoTradeReason } from '../types'

export function summarizeBarFeatures(bar: OhlcvData): BarFeatureSummary {
  const tr = bar.high - bar.low
  const body = Math.abs(bar.close - bar.open)
  const bodyPct = tr === 0 ? 0 : body / tr
  return { tr, body, bodyPct }
}

export function classifyBarType(bar: OhlcvData): BarType {
  const { tr, bodyPct } = summarizeBarFeatures(bar)

  if (tr === 0) return 'doji'
  if (bodyPct < 0.2) return 'doji'
  return bar.close >= bar.open ? 'bull' : 'bear'
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
