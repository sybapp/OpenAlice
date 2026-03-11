import type { OhlcvData } from '@/extension/technical-analysis/indicator-kit/index'
import type { IctSmcSwing } from '../types'

export function detectSwings(bars: OhlcvData[], lookback = 2): IctSmcSwing[] {
  if (bars.length < lookback * 2 + 1) return []
  const swings: IctSmcSwing[] = []

  for (let i = lookback; i < bars.length - lookback; i++) {
    const bar = bars[i]
    const left = bars.slice(i - lookback, i)
    const right = bars.slice(i + 1, i + 1 + lookback)
    const isHigh = left.every((other) => bar.high >= other.high) && right.every((other) => bar.high > other.high)
    const isLow = left.every((other) => bar.low <= other.low) && right.every((other) => bar.low < other.low)
    if (!isHigh && !isLow) continue

    const localRange = Math.max(...[...left, bar, ...right].map((item) => item.high))
      - Math.min(...[...left, bar, ...right].map((item) => item.low))
    const price = isHigh ? bar.high : bar.low
    swings.push({
      index: i,
      date: bar.date,
      price,
      kind: isHigh ? 'high' : 'low',
      strength: localRange === 0 ? 0 : Math.abs(bar.close - bar.open) / localRange,
    })
  }

  return swings
}
