import type { Brain } from '../../domains/cognition/brain/index.js'
import type { AccountManager } from '../../domains/trading/index.js'
import type { ITradingGit } from '../../domains/trading/index.js'
import type { Engine } from '../../core/engine.js'
import type { EventLog } from '../../core/event-log.js'
import type { Config, MarketDataBridge } from '../../core/types.js'
import type { CronSchedule } from '../cron/engine.js'
import type { INewsProvider } from '../../domains/research/news-collector/index.js'
import type { OhlcvStore } from '../../domains/technical-analysis/indicator-kit/index.js'

export type TraderAssetClass = 'crypto'
export type TraderAllowedOrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'take_profit'
export type TraderStrategyTemplateId = 'breakout' | 'trend-follow' | 'mean-revert'

export interface TraderStrategy {
  id: string
  label: string
  enabled: boolean
  sources: string[]
  universe: {
    asset: TraderAssetClass
    symbols: string[]
  }
  timeframes: {
    context: string
    structure: string
    execution: string
  }
  riskBudget: {
    perTradeRiskPercent: number
    maxGrossExposurePercent: number
    maxPositions: number
    maxDailyLossPercent?: number
  }
  behaviorRules: {
    preferences: string[]
    prohibitions: string[]
  }
  executionPolicy: {
    allowedOrderTypes: TraderAllowedOrderType[]
    requireProtection: boolean
    allowMarketOrders: boolean
    allowOvernight: boolean
  }
}

export interface TraderStrategyTemplate {
  id: TraderStrategyTemplateId
  label: string
  description: string
  defaults: TraderStrategy
}

export interface TraderStrategyGenerateInput {
  templateId: TraderStrategyTemplateId
  request: string
}

export interface TraderStrategyGenerateResult {
  draft: TraderStrategy
  yamlPreview: string
}

export interface TraderStrategyChangeReport {
  changedFields: string[]
  summary: string
  yamlDiff: string
}

export interface TraderStrategyUpdateResult {
  strategy: TraderStrategy
  changeReport: TraderStrategyChangeReport
}

export interface TraderStrategyPatch {
  behaviorRules?: {
    preferences?: string[]
    prohibitions?: string[]
  }
}

export interface TraderStrategySummary {
  id: string
  label: string
  enabled: boolean
  sources: string[]
  asset: TraderAssetClass
  symbols: string[]
}

export interface TraderJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: 'ok' | 'error' | null
  consecutiveErrors: number
}

export interface TraderJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  strategyId: string
  state: TraderJobState
  createdAt: number
}

export interface TraderJobCreate {
  name: string
  enabled?: boolean
  schedule: CronSchedule
  strategyId: string
}

export interface TraderJobPatch {
  name?: string
  enabled?: boolean
  schedule?: CronSchedule
  strategyId?: string
}

export interface TraderFirePayload {
  jobId: string
  jobName: string
  strategyId: string
}

export interface TraderDecision {
  status: 'trade' | 'watch' | 'skip'
  strategyId: string
  source: string
  symbol: string
  chosenScenario: string
  rationale: string
  invalidation: string[]
  actionsTaken: string[]
  brainUpdate: string
}

export interface TraderMarketCandidate {
  source: string
  symbol: string
  reason: string
}

export interface TraderMarketEvaluation {
  source: string
  symbol: string
  verdict: 'candidate' | 'skip'
  reason: string
}

export interface TraderMarketScanResult {
  candidates: TraderMarketCandidate[]
  evaluations: TraderMarketEvaluation[]
  summary: string
}

export interface TraderTradeThesisResult {
  status: 'thesis_ready' | 'no_trade'
  source: string
  symbol: string
  bias: 'long' | 'short' | 'flat'
  chosenScenario: string
  alternateScenario?: string
  rationale: string
  invalidation: string[]
  confidence: number
  contextNotes: string[]
}

export interface TraderRiskCheckResult {
  verdict: 'pass' | 'fail' | 'reduce'
  source: string
  symbol: string
  rationale: string
  maxRiskPercent?: number
}

export interface TraderPlannedOrder {
  aliceId: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'take_profit' | 'trailing_stop' | 'trailing_stop_limit' | 'moc'
  qty?: number
  notional?: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  reduceOnly?: boolean
  timeInForce: 'day' | 'gtc' | 'ioc' | 'fok' | 'opg' | 'gtd'
  goodTillDate?: string
  extendedHours?: boolean
  parentId?: string
  ocaGroup?: string
  protection?: {
    stopLossPct?: number
    takeProfitPct?: number
    stopLossPrice?: number
    takeProfitPrice?: number
    takeProfitSizeRatio?: number
  }
}

interface TraderTradePlanBase {
  source: string
  symbol: string
  chosenScenario: string
  rationale: string
  invalidation: string[]
  brainUpdate: string
}

export interface TraderTradePlanReadyResult extends TraderTradePlanBase {
  status: 'plan_ready'
  commitMessage: string
  orders: TraderPlannedOrder[]
}

export interface TraderTradePlanSkipResult extends TraderTradePlanBase {
  status: 'skip'
}

export type TraderTradePlanResult = TraderTradePlanReadyResult | TraderTradePlanSkipResult

export interface TraderTradeExecuteResult {
  status: 'execute' | 'abort'
  source: string
  symbol: string
  rationale: string
  brainUpdate: string
}

export interface TraderTradeReviewSummary {
  summary: string
  brainUpdate: string
  strategyPatch?: TraderStrategyPatch
  patchSummary?: string
}

export interface TraderJobEngine {
  start(): Promise<void>
  stop(): void
  add(params: TraderJobCreate): Promise<string>
  update(id: string, patch: TraderJobPatch): Promise<void>
  remove(id: string): Promise<void>
  list(): TraderJob[]
  runNow(id: string): Promise<void>
  get(id: string): TraderJob | undefined
}

export interface TraderRunnerResult {
  status: 'done' | 'skip'
  reason: string
  decision?: TraderDecision
  rawText?: string
}

export interface TraderRunnerDeps {
  config: Config
  engine: Engine
  eventLog: EventLog
  brain: Brain
  accountManager: AccountManager
  marketData: MarketDataBridge
  ohlcvStore: OhlcvStore
  newsStore: INewsProvider
  getAccountGit: (accountId: string) => ITradingGit | undefined
}

export interface TraderReviewResult {
  updated: boolean
  summary: string
  strategyId?: string
  patchApplied?: boolean
  patchSummary?: string
  yamlDiff?: string
}

export type TraderReviewJobState = TraderJobState

export interface TraderReviewJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  strategyId?: string
  createdAt: number
  state: TraderReviewJobState
}

export interface TraderReviewJobCreate {
  name: string
  enabled?: boolean
  schedule: CronSchedule
  strategyId?: string
}

export interface TraderReviewJobPatch {
  name?: string
  enabled?: boolean
  schedule?: CronSchedule
  strategyId?: string
}

export interface TraderReviewFirePayload {
  jobId: string
  jobName: string
  strategyId?: string
}

export interface TraderReviewJobEngine {
  start(): Promise<void>
  stop(): void
  add(params: TraderReviewJobCreate): Promise<string>
  update(id: string, patch: TraderReviewJobPatch): Promise<void>
  remove(id: string): Promise<void>
  list(): TraderReviewJob[]
  runNow(id: string): Promise<void>
  get(id: string): TraderReviewJob | undefined
}
