import type { Brain } from '../../extension/cognition/brain/index.js'
import type { AccountManager } from '../../extension/trading/index.js'
import type { ITradingGit } from '../../extension/trading/index.js'
import type { Engine } from '../../core/engine.js'
import type { EventLog } from '../../core/event-log.js'
import type { CronSchedule } from '../cron/engine.js'

export type TraderAssetClass = 'crypto' | 'equity'
export type TraderAllowedOrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'take_profit'

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
  engine: Engine
  eventLog: EventLog
  brain: Brain
  accountManager: AccountManager
  getAccountGit: (accountId: string) => ITradingGit | undefined
}

export interface TraderReviewResult {
  updated: boolean
  summary: string
  strategyId?: string
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
