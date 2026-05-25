import type { OhlcvAssetClass } from '../market-data/ohlcv/types.js'

export const SIGNAL_ENGINE_VERSION = '1'

export type SignalDirection = 'bullish' | 'bearish'

export interface ReplayBar {
  time: string
  open: string
  high: string
  low: string
  close: string
  volume: string
  vwap?: string
  closed: true
}

export interface SignalEngineSignal {
  id: string
  kind: 'structure_volume_price'
  label: string
  message: string
  direction: SignalDirection
  closedBarTime: string
  index: number
  lmtPrice: string
  stopLoss: { price: string; limitPrice?: string }
  takeProfit?: { price: string }
  order: {
    orderType: 'LMT'
    action: 'BUY' | 'SELL'
    lmtPrice: string
    stopLoss: { price: string; limitPrice?: string }
    takeProfit?: { price: string }
  }
  features: {
    structure?: string
    zone?: string
    liquidity?: string
    volumeScore: string
    vwap: string
  }
  sourceHash: string
  canonicalPayloadHash: string
}

export interface SignalEngineRun {
  runId: string
  engineVersion: string
  status: 'completed' | 'skipped' | 'error'
  startedAt: string
  finishedAt: string
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider: string
  strategyId: string
  strategyVersion: string
  riskTemplateId: string
  riskTemplateVersion: string
  closedBarsOnly: true
  dataFingerprint: string
  inputHash: string
  outputHash: string
  signals: SignalEngineSignal[]
  summary: string
  error?: string
  autoStageStatus?: SignalEngineAutoStageStatus
  autoStageError?: string
  autoStage?: SignalEngineAutoStageResult
}

export type SignalEngineAutoStageStatus = 'disabled' | 'skipped' | 'staged' | 'partial' | 'failed'

export interface SignalEngineAutoStageEntry {
  signalId: string
  status: 'staged' | 'failed'
  setupId?: string
  error?: string
}

export interface SignalEngineAutoStageResult {
  status: SignalEngineAutoStageStatus
  enabled: boolean
  defaultUtaId?: string
  attempted: number
  staged: number
  failed: number
  entries: SignalEngineAutoStageEntry[]
  error?: string
}

export interface SignalEngineArtifactResult {
  status: SignalEngineRun['status']
  strategyId: string
  strategyVersion: string
  symbol: string
  interval: string
  input: unknown
  output: SignalEngineRun
  events: unknown[]
  summary: string
  error?: string
  metadata?: Record<string, unknown>
}

export interface RiskTemplate {
  id: string
  version: string
  totalQuantity?: string
  cashQty?: string
  stopLossBps?: string
  takeProfitBps?: string
}

export interface SignalStageRequest {
  signalRunId: string
  signalId: string
  source: string
  aliceId: string
  riskTemplate: RiskTemplate
}

export interface StrategyContext {
  now: string
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider: string
  riskTemplate: RiskTemplate
}

export interface StrategyPlugin {
  id: string
  version: string
  evaluate(history: ReplayBar[], context: StrategyContext): SignalEngineSignal[]
}

export interface RunSignalEngineInput {
  asset: OhlcvAssetClass
  symbol: string
  interval: string
  provider: string
  strategy: StrategyPlugin
  riskTemplate: RiskTemplate
  bars: ReplayBar[]
  startedAt?: string
}
