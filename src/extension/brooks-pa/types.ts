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

export type BrooksPaAnalyzeOutput = {
  indexing: { oldest: number; latest: number }
  marketTypeByTf: Record<string, { marketType: string; confidence: number }>
  levels: Array<{ tf: string; kind: string; price: number; note?: string }>
  patterns: Array<{ tf: string; name: string; note?: string }>
  tradeCandidates: Array<{ tf: string; direction: 'long' | 'short'; rationale: string }>
  noTrade: BrooksNoTradeReason[]
  recentBars: RecentBar[]
  keyBars: Array<{ tf: string; index: number; date: string; note: string }>
}
