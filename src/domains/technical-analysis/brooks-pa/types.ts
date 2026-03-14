export type AssetClass = 'equity' | 'crypto' | 'currency'

export type Timeframes = {
  context: string
  structure: string
  execution: string
}

export type BrooksMidpointAvoidance = {
  enabled: boolean
  band: number
}

export type BrooksPaAnalyzeInput = {
  asset: AssetClass
  symbol: string
  timeframes?: Partial<Timeframes>
  lookbackBars?: number
  recentBars?: number
  midpointAvoidance?: Partial<BrooksMidpointAvoidance>
}

export type BarType = 'bull' | 'bear' | 'doji'

export type BarFeatureSummary = {
  tr: number
  body: number
  bodyPct: number
}

export type RecentBar = {
  index: number
  date: string
  open: number
  high: number
  low: number
  close: number
  barType: BarType
  features: BarFeatureSummary
}

export type BrooksNoTradeReason = {
  code: 'TR_MIDPOINT'
  message: string
  details?: Record<string, unknown>
}

export type BrooksFrame = {
  tf: string
  bars: RecentBar[]
  latestIndex: number
  latestClose: number | null
  rangeHigh: number | null
  rangeLow: number | null
}

export type BrooksStructureSignal = {
  tf: string
  direction: 'long' | 'short' | 'neutral'
  marketType: 'trend' | 'range' | 'breakout' | 'channel' | 'unknown'
  confidence: number
  breakoutDirection?: 'up' | 'down'
  followThrough?: boolean
  failedBreakout?: boolean
  secondEntry?: 'long' | 'short' | null
  channel?: 'bull' | 'bear' | null
  wedge?: 'bull' | 'bear' | null
}

export type BrooksDecisionWindowSummary = {
  tf: string
  bars: RecentBar[]
  summary: {
    barCount: number
    bullBars: number
    bearBars: number
    dojiBars: number
    netChange: number
    rangeHigh: number | null
    rangeLow: number | null
    latestClose: number | null
    dominantSide: 'bull' | 'bear' | 'balanced'
    breakoutState: 'up' | 'down' | 'inside'
    notes: string[]
  }
}

export type BrooksPaAnalyzeOutput = {
  indexing: { oldest: number; latest: number }
  marketTypeByTf: Record<string, { marketType: string; confidence: number }>
  levels: Array<{ tf: string; kind: string; price: number; note?: string }>
  patterns: Array<{ tf: string; name: string; note?: string }>
  tradeCandidates: Array<{ tf: string; direction: 'long' | 'short'; rationale: string }>
  noTrade: BrooksNoTradeReason[]
  recentBars: RecentBar[]
  keyBars: Array<{ tf: string; index: number; date: string; note: string }>
  decisionWindow: BrooksDecisionWindowSummary
}
