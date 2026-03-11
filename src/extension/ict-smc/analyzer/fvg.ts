import type { OhlcvData } from '@/extension/indicator-kit/index'
import type { IctSmcFairValueGap } from '../types'

export function detectFairValueGaps(bars: OhlcvData[]): IctSmcFairValueGap[] {
  const fvgs: IctSmcFairValueGap[] = []
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2]
    const c = bars[i]

    if (c.low > a.high) {
      const top = c.low
      const bottom = a.high
      let fillIndex: number | null = null
      let lowestTouch = top
      for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].low <= top && bars[j].high >= bottom) {
          lowestTouch = Math.min(lowestTouch, bars[j].low)
          if (bars[j].low <= bottom) {
            fillIndex = j
            lowestTouch = bottom
            break
          }
        }
      }
      fvgs.push({
        index: i,
        side: 'bullish',
        top,
        bottom,
        size: top - bottom,
        filled: fillIndex != null,
        fillIndex,
        remainingGap: Math.max(0, lowestTouch - bottom),
      })
    }

    if (c.high < a.low) {
      const top = a.low
      const bottom = c.high
      let fillIndex: number | null = null
      let highestTouch = bottom
      for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].high >= bottom && bars[j].low <= top) {
          highestTouch = Math.max(highestTouch, bars[j].high)
          if (bars[j].high >= top) {
            fillIndex = j
            highestTouch = top
            break
          }
        }
      }
      fvgs.push({
        index: i,
        side: 'bearish',
        top,
        bottom,
        size: top - bottom,
        filled: fillIndex != null,
        fillIndex,
        remainingGap: Math.max(0, top - highestTouch),
      })
    }
  }
  return fvgs
}
