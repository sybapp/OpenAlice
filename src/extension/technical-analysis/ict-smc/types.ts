import type { OhlcvData } from '@/extension/technical-analysis/indicator-kit/index'

export type IctSmcSwing = {
  index: number
  date: string
  price: number
  kind: 'high' | 'low'
  strength: number
}

export type IctSmcLiquidityPool = {
  side: 'buy' | 'sell'
  price: number
  kind: 'equal-highs' | 'equal-lows' | 'external-high' | 'external-low'
  sweepIndex: number | null
  swept: boolean
  members: number[]
}

export type IctSmcFairValueGap = {
  index: number
  side: 'bullish' | 'bearish'
  top: number
  bottom: number
  size: number
  filled: boolean
  fillIndex: number | null
  remainingGap: number
}

export type IctSmcStructureBreak = {
  type: 'BOS' | 'CHOCH'
  side: 'bullish' | 'bearish'
  brokenSwingIndex: number
  breakIndex: number
  level: number
}

export type IctSmcStructureSummary = {
  bias: 'bullish' | 'bearish' | 'neutral'
  bos: IctSmcStructureBreak[]
  choch: IctSmcStructureBreak[]
  displacement: {
    active: boolean
    side: 'bullish' | 'bearish' | 'neutral'
    size: number
    threshold: number
  }
  mitigation: {
    active: boolean
    touchedFvgIndexes: number[]
  }
  premiumDiscount: {
    equilibrium: number | null
    state: 'premium' | 'discount' | 'equilibrium' | 'unknown'
  }
  latestSwingHigh: IctSmcSwing | null
  latestSwingLow: IctSmcSwing | null
}

export type IctSmcDecisionWindow = {
  tf: string
  bars: OhlcvData[]
  summary: {
    barCount: number
    latestClose: number | null
    rangeHigh: number | null
    rangeLow: number | null
    liquiditySweep: 'buy-side' | 'sell-side' | 'none'
    displacement: 'bullish' | 'bearish' | 'none'
    mitigation: 'active' | 'none'
    premiumDiscount: 'premium' | 'discount' | 'equilibrium' | 'unknown'
    notes: string[]
  }
}

export type IctSmcAnalyzeOutput = {
  symbol: string
  timeframe: string
  lookbackBars: number
  recentBars: number
  swings: IctSmcSwing[]
  liquidity: IctSmcLiquidityPool[]
  fvgs: IctSmcFairValueGap[]
  structure: IctSmcStructureSummary
  decisionWindow: IctSmcDecisionWindow
}
