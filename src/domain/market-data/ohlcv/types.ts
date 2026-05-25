export type OhlcvAssetClass = 'equity' | 'crypto' | 'currency' | 'commodity'

export interface OhlcvBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  vwap?: number | null
  symbol?: string | null
  [key: string]: unknown
}

export interface OhlcvPartitionKey {
  provider: string
  asset: OhlcvAssetClass
  symbol: string
  interval: string
}

export interface OhlcvCacheMeta extends OhlcvPartitionKey {
  from: string
  to: string
  bars: number
  updatedAt: string
}

export interface OhlcvRange {
  startDate?: string | null
  endDate?: string | null
}

export interface OhlcvCacheConfig {
  enabled: boolean
  dir: string
  maxGapRequests: number
  writeClosedOnly: boolean
}

export interface OhlcvWatchItem {
  asset: OhlcvAssetClass
  symbol: string
  intervals: string[]
  provider?: string
  lookbackBars?: number
}

export interface OhlcvWatchConfig {
  enabled: boolean
  every: string
  items: OhlcvWatchItem[]
}

export type MarketDataAlertMode = 'deterministic' | 'agent' | 'both'

export interface MarketDataAlertWorkspaceConfig {
  workspaceId?: string
  agent: 'workspace-default' | 'claude' | 'codex'
  resume: 'auto' | 'fresh' | 'last'
  timeoutMs: number
}

export interface MarketDataAlertThresholds {
  maxSignalAgeBars?: number
  minVolumeScore?: number
}

export interface MarketDataAlertItem {
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider?: string
  enabled?: boolean
  lookbackBars?: number
  mode?: MarketDataAlertMode
  cooldownMinutes?: number
  options?: Record<string, unknown>
  thresholds?: MarketDataAlertThresholds
  workspace?: MarketDataAlertWorkspaceConfig
}

export interface MarketDataAlertConfig {
  enabled: boolean
  every: string
  mode: MarketDataAlertMode
  cooldownMinutes: number
  lookbackBars: number
  workspace?: MarketDataAlertWorkspaceConfig
  items: MarketDataAlertItem[]
}

export type MarketDataAlertRunStatus = 'triggered' | 'skipped' | 'error'

export type MarketDataAlertFeedbackRating = 'useful' | 'false_positive' | 'ignored' | 'needs_tuning'

export interface MarketDataAlertFeedback {
  rating: MarketDataAlertFeedbackRating
  note?: string
  updatedAt: string
}

export interface MarketDataAlertRunSignal {
  id: string
  kind: 'structure' | 'zone' | 'volume' | 'liquidity' | 'bpr' | 'confluence' | 'vp_level' | 'vwap_deviation' | 'stop_run' | 'unusual_volume' | 'ifvg'
  label: string
  direction?: 'bullish' | 'bearish'
  index: number
  time: string | number
  price?: number
  message: string
  volumeConfirmation?: 'confirmed' | 'weak' | 'unavailable'
  score?: number
  confluenceScore?: number
}

export interface MarketDataAlertWorkspaceExecution {
  ok: boolean
  skipped?: boolean
  error?: string
  workspaceId?: string
  agent?: string
}

export interface MarketDataAlertRunRecord {
  runId: string
  startedAt: string
  finishedAt: string
  asset?: OhlcvAssetClass
  symbol?: string
  interval?: string
  provider?: string
  mode?: MarketDataAlertMode
  status: MarketDataAlertRunStatus
  skipped?: boolean
  reason?: string
  latestClose?: number
  signals: MarketDataAlertRunSignal[]
  notified: boolean
  taskRequested: boolean
  workspaceExecution?: MarketDataAlertWorkspaceExecution
  error?: string
  summary: string
  feedback?: MarketDataAlertFeedback
}
