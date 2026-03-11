import type { OhlcvData } from '@/extension/technical-analysis/indicator-kit/index'
import type { IctSmcLiquidityPool, IctSmcSwing } from '../types'

function nearlyEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance
}

export function detectLiquidityPools(swings: IctSmcSwing[], bars: OhlcvData[]): IctSmcLiquidityPool[] {
  if (swings.length === 0 || bars.length === 0) return []
  const range = Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low))
  const tolerance = Math.max(range * 0.01, 1e-9)
  const pools: IctSmcLiquidityPool[] = []

  for (const kind of ['high', 'low'] as const) {
    const sameSide = swings.filter((swing) => swing.kind === kind)
    const used = new Set<number>()
    for (let i = 0; i < sameSide.length; i++) {
      if (used.has(i)) continue
      const cluster = [sameSide[i]]
      used.add(i)
      for (let j = i + 1; j < sameSide.length; j++) {
        if (used.has(j)) continue
        if (nearlyEqual(sameSide[i].price, sameSide[j].price, tolerance)) {
          cluster.push(sameSide[j])
          used.add(j)
        }
      }
      if (cluster.length < 2) continue
      const price = cluster.reduce((acc, swing) => acc + swing.price, 0) / cluster.length
      const sweepIndex = bars.findIndex((bar, index) => index > cluster[cluster.length - 1].index
        && (kind === 'high' ? bar.high > price + tolerance : bar.low < price - tolerance))
      pools.push({
        side: kind === 'high' ? 'buy' : 'sell',
        price,
        kind: kind === 'high' ? 'equal-highs' : 'equal-lows',
        sweepIndex: sweepIndex >= 0 ? sweepIndex : null,
        swept: sweepIndex >= 0,
        members: cluster.map((swing) => swing.index),
      })
    }
  }

  for (const kind of ['high', 'low'] as const) {
    const values = bars.map((bar, index) => ({ index, price: kind === 'high' ? bar.high : bar.low }))
    const clusters: Array<{ price: number; members: number[] }> = []
    for (const value of values) {
      const cluster = clusters.find((entry) => nearlyEqual(entry.price, value.price, tolerance))
      if (cluster) {
        cluster.members.push(value.index)
        cluster.price = (cluster.price * (cluster.members.length - 1) + value.price) / cluster.members.length
      } else {
        clusters.push({ price: value.price, members: [value.index] })
      }
    }
    for (const cluster of clusters) {
      if (cluster.members.length < 2) continue
      const duplicate = pools.some((pool) => pool.kind === (kind === 'high' ? 'equal-highs' : 'equal-lows')
        && nearlyEqual(pool.price, cluster.price, tolerance))
      if (duplicate) continue
      const lastMember = cluster.members[cluster.members.length - 1]
      const sweepIndex = bars.findIndex((bar, index) => index > lastMember
        && (kind === 'high' ? bar.high > cluster.price + tolerance : bar.low < cluster.price - tolerance))
      pools.push({
        side: kind === 'high' ? 'buy' : 'sell',
        price: cluster.price,
        kind: kind === 'high' ? 'equal-highs' : 'equal-lows',
        sweepIndex: sweepIndex >= 0 ? sweepIndex : null,
        swept: sweepIndex >= 0,
        members: cluster.members,
      })
    }
  }

  const latestHigh = swings.filter((swing) => swing.kind === 'high').at(-1)
  const latestLow = swings.filter((swing) => swing.kind === 'low').at(-1)
  if (latestHigh) {
    const sweepIndex = bars.findIndex((bar, index) => index > latestHigh.index && bar.high > latestHigh.price)
    pools.push({ side: 'buy', price: latestHigh.price, kind: 'external-high', sweepIndex: sweepIndex >= 0 ? sweepIndex : null, swept: sweepIndex >= 0, members: [latestHigh.index] })
  }
  if (latestLow) {
    const sweepIndex = bars.findIndex((bar, index) => index > latestLow.index && bar.low < latestLow.price)
    pools.push({ side: 'sell', price: latestLow.price, kind: 'external-low', sweepIndex: sweepIndex >= 0 ? sweepIndex : null, swept: sweepIndex >= 0, members: [latestLow.index] })
  }

  return pools
}
