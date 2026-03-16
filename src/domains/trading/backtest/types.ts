import { randomUUID } from 'node:crypto'
import type { Contract } from '../contract.js'
import type { AccountInfo, Order, Position, Quote } from '../interfaces.js'
import type { Operation, GitExportState, GitState, OrderStatusUpdate } from '../git/types.js'
import type { Engine } from '../../../core/engine.js'

export interface BacktestBar {
  ts: string
  symbol: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  bid?: number
  ask?: number
}

export interface ReplayQuoteView {
  symbol: string
  ts: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  bid?: number
  ask?: number
}

export interface HistoricalMarketReplayOptions {
  bars: BacktestBar[]
  startTime?: string
}

export interface BacktestAccountOptions {
  id: string
  label: string
  replay: {
    getCurrentTime(): Date
    getCurrentQuote(symbol: string): Quote
    getCurrentIndex(): number
    getCurrentBars(): BacktestBar[]
    getBars(): BacktestBar[]
  }
  initialCash: number
  /** Fee rate per trade (e.g. 0.001 = 0.1%). Default: 0 */
  feeRate?: number
  /** Slippage in basis points (e.g. 5 = 0.05%). Default: 0 */
  slippageBps?: number
}

export interface BacktestStrategyContext {
  runId: string
  step: number
  timestamp: string
  accountId: string
  bars: Array<Partial<BacktestBar>>
  account?: AccountInfo
  positions?: Position[]
  orders?: Order[]
}

export interface BacktestStrategyDecision {
  operations: Operation[]
  summaryText?: string
}

export interface BacktestStrategyDriver {
  decide(context: BacktestStrategyContext): Promise<BacktestStrategyDecision>
}

export interface ScriptedStrategyDriverOptions {
  strategy: (context: BacktestStrategyContext) => Promise<Operation[]> | Operation[]
}

export interface AIBacktestStrategyDriverOptions {
  ask: (context: BacktestStrategyContext) => Promise<{ text?: string; operations?: Operation[] }>
  eventLog: {
    append<T>(type: string, payload: T): Promise<unknown>
  }
}

export interface BacktestRunSummary {
  runId: string
  startEquity: number
  endEquity: number
  totalReturn: number
  realizedPnL: number
  unrealizedPnL: number
  maxDrawdown: number
  tradeCount: number
  winRate: number
  guardRejectionCount: number
}

export interface BacktestRunStepSnapshot {
  runId: string
  step: number
  ts: string
  equity: number
  realizedPnL: number
  unrealizedPnL: number
}

export interface BacktestRunnerOptions {
  runId: string
  replay: {
    getCurrentTime(): Date
    getCurrentIndex(): number
    getCurrentBars(): BacktestBar[]
    step(): boolean
    isFinished(): boolean
  }
  account: {
    id: string
    getAccount(): Promise<AccountInfo>
    getPositions(): Promise<Position[]>
    getOrders(): Promise<Order[]>
    syncPendingOrders(orderIds?: string[]): Promise<OrderStatusUpdate[]>
  }
  git: {
    add(operation: Operation): unknown
    commit(message: string): unknown
    push(): Promise<{ rejected: Array<{ status: string }>; filled: Array<{ status: string }> }>
    sync(updates: OrderStatusUpdate[], currentState: GitState): Promise<{ updatedCount: number }>
    getPendingOrderIds(): Array<{ orderId: string; symbol: string }>
    setCurrentRound(round: number): void
  }
  getGitState: () => Promise<{ cash: number; equity: number; realizedPnL: number; unrealizedPnL: number; positions: Position[]; pendingOrders: Order[] }>
  eventLog: {
    append<T>(type: string, payload: T): Promise<unknown>
  }
  strategyDriver: BacktestStrategyDriver
  onStep?: (snapshot: BacktestRunStepSnapshot) => Promise<void> | void
}

export interface BacktestHolding {
  contract: Contract
  qty: number
  avgEntryPrice: number
  side: 'long' | 'short'
}

export type BacktestRunMode = 'scripted' | 'ai'
export type BacktestRunStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface BacktestDecisionPlanEntry {
  step: number
  operations: Operation[]
}

export interface ScriptedBacktestRunStrategyConfig {
  mode: 'scripted'
  decisions: BacktestDecisionPlanEntry[]
}

export interface AIBacktestRunStrategyConfig {
  mode: 'ai'
  prompt: string
  strategyId?: string
  systemPrompt?: string
  maxHistoryEntries?: number
}

export type BacktestRunStrategyConfig =
  | ScriptedBacktestRunStrategyConfig
  | AIBacktestRunStrategyConfig

export interface BacktestRunConfig {
  runId?: string
  accountId?: string
  accountLabel?: string
  initialCash: number
  startTime?: string
  guards?: Array<{ type: string; options?: Record<string, unknown> }>
  bars: BacktestBar[]
  strategy: BacktestRunStrategyConfig
}

export interface BacktestRunManifest {
  runId: string
  status: BacktestRunStatus
  mode: BacktestRunMode
  createdAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  sessionId?: string
  artifactDir: string
  barCount: number
  currentStep: number
  accountId: string
  accountLabel: string
  initialCash: number
  startTime?: string
  guards: Array<{ type: string; options?: Record<string, unknown> }>
}

export interface BacktestEquityPoint {
  step: number
  ts: string
  equity: number
  realizedPnL: number
  unrealizedPnL: number
}

export interface BacktestRunRecord {
  manifest: BacktestRunManifest
  summary?: BacktestRunSummary
}

export interface BacktestStorage {
  claimRunId(runId: string): Promise<void>
  releaseRunId(runId: string): Promise<void>
  createRun(manifest: BacktestRunManifest): Promise<void>
  updateManifest(runId: string, patch: Partial<BacktestRunManifest>): Promise<BacktestRunManifest>
  getManifest(runId: string): Promise<BacktestRunManifest | null>
  listRuns(): Promise<BacktestRunManifest[]>
  writeSummary(runId: string, summary: BacktestRunSummary): Promise<void>
  readSummary(runId: string): Promise<BacktestRunSummary | null>
  appendEquityPoint(runId: string, point: BacktestEquityPoint): Promise<void>
  readEquityCurve(runId: string, opts?: { limit?: number }): Promise<BacktestEquityPoint[]>
  writeGitState(runId: string, state: GitExportState): Promise<void>
  readGitState(runId: string): Promise<GitExportState | null>
  readEventEntries(runId: string, opts?: { afterSeq?: number; limit?: number; type?: string }): Promise<Array<{ seq: number; ts: number; type: string; payload: unknown }>>
  readSessionEntries(runId: string): Promise<unknown[]>
  getRunPaths(runId: string): {
    runDir: string
    manifestPath: string
    summaryPath: string
    equityCurvePath: string
    eventLogPath: string
    gitStatePath: string
  }
}

export interface BacktestRunManager {
  startRun(config: BacktestRunConfig): Promise<{ runId: string }>
  waitForRun(runId: string): Promise<BacktestRunManifest>
  listRuns(): Promise<BacktestRunManifest[]>
  getRun(runId: string): Promise<BacktestRunRecord | null>
  getSummary(runId: string): Promise<BacktestRunSummary | null>
  getEquityCurve(runId: string, opts?: { limit?: number }): Promise<BacktestEquityPoint[]>
  getEvents(runId: string, opts?: { afterSeq?: number; limit?: number; type?: string }): Promise<Array<{ seq: number; ts: number; type: string; payload: unknown }>>
  getGitState(runId: string): Promise<GitExportState | null>
  getSessionEntries(runId: string): Promise<unknown[]>
}

export interface BacktestRunManagerOptions {
  storage: BacktestStorage
  engine: Engine
}

export function createBacktestRunId(): string {
  return `bt-${randomUUID().slice(0, 8)}`
}
