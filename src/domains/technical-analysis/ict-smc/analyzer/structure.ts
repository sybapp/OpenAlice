import type { OhlcvData } from '@/domains/technical-analysis/indicator-kit/index'
import type {
  IctSmcDecisionWindow,
  IctSmcFairValueGap,
  IctSmcLiquidityPool,
  IctSmcStructureBreak,
  IctSmcStructureSummary,
  IctSmcSwing,
} from '../types'

function latestOfKind(swings: IctSmcSwing[], kind: 'high' | 'low'): IctSmcSwing | null {
  return swings.filter((swing) => swing.kind === kind).at(-1) ?? null
}

export function detectBosChoch(swings: IctSmcSwing[], bars: OhlcvData[]): Pick<IctSmcStructureSummary, 'bias' | 'bos' | 'choch' | 'latestSwingHigh' | 'latestSwingLow'> {
  const latestSwingHigh = latestOfKind(swings, 'high')
  const latestSwingLow = latestOfKind(swings, 'low')
  const bos: IctSmcStructureBreak[] = []
  const choch: IctSmcStructureBreak[] = []
  let lastSide: 'bullish' | 'bearish' | null = null

  for (const swing of swings) {
    const breakIndex = bars.findIndex((bar, index) => index > swing.index
      && (swing.kind === 'high' ? bar.close > swing.price : bar.close < swing.price))
    if (breakIndex < 0) continue
    const side = swing.kind === 'high' ? 'bullish' : 'bearish'
    const entry: IctSmcStructureBreak = {
      type: lastSide && lastSide !== side ? 'CHOCH' : 'BOS',
      side,
      brokenSwingIndex: swing.index,
      breakIndex,
      level: swing.price,
    }
    if (entry.type === 'BOS') bos.push(entry)
    else choch.push(entry)
    lastSide = side
  }

  const latestBreak = [...bos, ...choch].sort((a, b) => a.breakIndex - b.breakIndex).at(-1)
  const bias = latestBreak?.side ?? 'neutral'
  return { bias, bos, choch, latestSwingHigh, latestSwingLow }
}

export function detectStructure(params: {
  swings: IctSmcSwing[]
  bars: OhlcvData[]
  fvgs: IctSmcFairValueGap[]
  liquidity: IctSmcLiquidityPool[]
}): IctSmcStructureSummary {
  const { swings, bars, fvgs } = params
  const bosChoch = detectBosChoch(swings, bars)
  const recent = bars.slice(-10)
  const last = recent.at(-1)
  const prev = recent.at(-2)
  const avgRange = recent.length === 0 ? 0 : recent.reduce((acc, bar) => acc + (bar.high - bar.low), 0) / recent.length
  const lastRange = last ? last.high - last.low : 0
  const displacement = {
    active: Boolean(last && prev && lastRange > avgRange * 1.3 && Math.abs(last.close - last.open) > Math.abs((prev.close - prev.open) || 0)),
    side: !last ? 'neutral' as const : last.close >= last.open ? 'bullish' as const : 'bearish' as const,
    size: lastRange,
    threshold: avgRange * 1.3,
  }

  const touchedFvgIndexes = fvgs
    .filter((fvg) => !fvg.filled && last && last.high >= fvg.bottom && last.low <= fvg.top)
    .map((fvg) => fvg.index)
  const mitigation = {
    active: touchedFvgIndexes.length > 0,
    touchedFvgIndexes,
  }

  const latestSwingHigh = bosChoch.latestSwingHigh
  const latestSwingLow = bosChoch.latestSwingLow
  const equilibrium = latestSwingHigh && latestSwingLow
    ? (latestSwingHigh.price + latestSwingLow.price) / 2
    : null
  const premiumDiscount = {
    equilibrium,
    state: equilibrium == null || !last
      ? 'unknown' as const
      : Math.abs(last.close - equilibrium) < Math.max((latestSwingHigh!.price - latestSwingLow!.price) * 0.05, 1e-9)
        ? 'equilibrium' as const
        : last.close > equilibrium
          ? 'premium' as const
          : 'discount' as const,
  }

  return {
    bias: bosChoch.bias,
    bos: bosChoch.bos,
    choch: bosChoch.choch,
    displacement,
    mitigation,
    premiumDiscount,
    latestSwingHigh,
    latestSwingLow,
  }
}

export function summarizeIctDecisionWindow(params: {
  tf: string
  bars: OhlcvData[]
  liquidity: IctSmcLiquidityPool[]
  structure: IctSmcStructureSummary
}): IctSmcDecisionWindow {
  const recent = params.bars.slice(-10)
  const latest = recent.at(-1) ?? null
  const rangeHigh = recent.length ? Math.max(...recent.map((bar) => bar.high)) : null
  const rangeLow = recent.length ? Math.min(...recent.map((bar) => bar.low)) : null
  const recentLiquiditySweep = params.liquidity.find((pool) => pool.swept && pool.sweepIndex != null && pool.sweepIndex >= params.bars.length - recent.length)
  const notes: string[] = []
  if (recentLiquiditySweep?.side === 'buy') notes.push('Recent buy-side liquidity sweep detected.')
  if (recentLiquiditySweep?.side === 'sell') notes.push('Recent sell-side liquidity sweep detected.')
  if (params.structure.displacement.active) notes.push(`${params.structure.displacement.side} displacement is active in the decision window.`)
  if (params.structure.mitigation.active) notes.push('Price is interacting with an unfilled FVG / mitigation zone.')
  if (notes.length === 0 && latest && rangeHigh != null && rangeLow != null) {
    const equilibrium = (rangeHigh + rangeLow) / 2
    notes.push(latest.close >= equilibrium
      ? 'Price is trading in the upper half of the recent decision window.'
      : 'Price is trading in the lower half of the recent decision window.')
  }

  return {
    tf: params.tf,
    bars: recent,
    summary: {
      barCount: recent.length,
      latestClose: latest?.close ?? null,
      rangeHigh,
      rangeLow,
      liquiditySweep: recentLiquiditySweep?.side === 'buy' ? 'buy-side' : recentLiquiditySweep?.side === 'sell' ? 'sell-side' : 'none',
      displacement: params.structure.displacement.active && params.structure.displacement.side !== 'neutral'
        ? params.structure.displacement.side
        : 'none',
      mitigation: params.structure.mitigation.active ? 'active' : 'none',
      premiumDiscount: params.structure.premiumDiscount.state,
      notes,
    },
  }
}
