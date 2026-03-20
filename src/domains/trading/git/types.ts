/**
 * Trading-as-Git type definitions
 *
 * Unified git-like state management for tracking trading operation history.
 */

import type { SecType } from '../contract.js'
import type { Position, Order, OrderType, TimeInForce } from '../interfaces.js'

// ==================== Commit Hash ====================

/** 8-character short SHA-256 hash. */
export type CommitHash = string

// ==================== Operation ====================

export type OperationAction =
  | 'placeOrder'
  | 'modifyOrder'
  | 'closePosition'
  | 'cancelOrder'
  | 'syncOrders'

// ---- Per-action param types ----

export interface PlaceOrderParams {
  aliceId?: string
  symbol?: string
  side: 'buy' | 'sell'
  type: OrderType
  qty?: number
  notional?: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  reduceOnly?: boolean
  timeInForce?: TimeInForce
  goodTillDate?: string
  extendedHours?: boolean
  parentId?: string
  ocaGroup?: string
  secType?: string
  currency?: string
  exchange?: string
  protection?: {
    stopLossPct?: number
    takeProfitPct?: number
    stopLossPrice?: number
    takeProfitPrice?: number
    takeProfitSizeRatio?: number
  }
  /** Legacy alias for qty used by some providers */
  size?: number
  /** Legacy alias for notional used by some providers */
  usd_size?: number
}

export interface ModifyOrderParams {
  orderId: string
  qty?: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  type?: OrderType
  timeInForce?: TimeInForce
  goodTillDate?: string
}

export interface ClosePositionParams {
  aliceId?: string
  symbol?: string
  qty?: number
  secType?: string
  /** Legacy alias for qty */
  size?: number
}

export interface CancelOrderParams {
  orderId: string
}

export interface SyncOrdersParams {
  orderIds: string[]
}

// ---- Discriminated union ----

export type Operation =
  | { action: 'placeOrder'; params: PlaceOrderParams }
  | { action: 'modifyOrder'; params: ModifyOrderParams }
  | { action: 'closePosition'; params: ClosePositionParams }
  | { action: 'cancelOrder'; params: CancelOrderParams }
  | { action: 'syncOrders'; params: SyncOrdersParams }

// ==================== Operation Result ====================

export type OperationStatus = 'filled' | 'pending' | 'rejected' | 'cancelled' | 'partially_filled'

export interface OperationResult {
  action: OperationAction
  success: boolean
  orderId?: string
  status: OperationStatus
  filledPrice?: number
  filledQty?: number
  error?: string
  raw?: unknown
}

// ==================== Wallet State ====================

/** State snapshot taken after each commit. Uses unified Position/Order types. */
export interface GitState {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  positions: Position[]
  pendingOrders: Order[]
}

// ==================== Commit ====================

export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number
}

// ==================== API Results ====================

export interface AddResult {
  staged: true
  index: number
  operation: Operation
}

export interface CommitPrepareResult {
  prepared: true
  hash: CommitHash
  message: string
  operationCount: number
}

export type PushMode = 'best-effort' | 'fail-fast'

export interface PushResult {
  hash: CommitHash
  message: string
  operationCount: number
  mode: PushMode
  filled: OperationResult[]
  pending: OperationResult[]
  rejected: OperationResult[]
}

export interface GitStatus {
  staged: Operation[]
  pendingMessage: string | null
  head: CommitHash | null
  commitCount: number
}

export interface OperationSummary {
  symbol: string
  action: OperationAction
  change: string
  status: OperationStatus
}

export interface CommitLogEntry {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  timestamp: string
  round?: number
  operations: OperationSummary[]
}

// ==================== Export State ====================

export interface GitArchiveMetadata {
  archivedCount: number
  oldestHash: CommitHash | null
  newestHash: CommitHash | null
}

export interface PersistedProtectionWatcher {
  orderId: string
  contractRef: { aliceId?: string; symbol?: string; secType?: SecType }
  plan: {
    stopLossPrice?: number; stopLossPct?: number
    takeProfitPrice?: number; takeProfitPct?: number
    takeProfitSizeRatio?: number
  }
  startedAt: number
}

export interface GitExportState {
  commits: GitCommit[]
  head: CommitHash | null
  archive?: GitArchiveMetadata
  protectionWatchers?: PersistedProtectionWatcher[]
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string
  symbol: string
  previousStatus: OperationStatus
  currentStatus: OperationStatus
  filledPrice?: number
  filledQty?: number
  realizedPnLDelta?: number
}

export interface SyncResult {
  hash: CommitHash
  updatedCount: number
  updates: OrderStatusUpdate[]
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  /** Contract aliceId or symbol, or "all". */
  symbol: string
  /** "@88000" (absolute) or "+10%" / "-5%" (relative). */
  change: string
}

export interface SimulationPositionCurrent {
  symbol: string
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  currentPrice: number
  unrealizedPnL: number
  marketValue: number
}

export interface SimulationPositionAfter {
  symbol: string
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  simulatedPrice: number
  unrealizedPnL: number
  marketValue: number
  pnlChange: number
  priceChangePercent: string
}

export interface SimulatePriceChangeResult {
  success: boolean
  error?: string
  currentState: {
    equity: number
    unrealizedPnL: number
    totalPnL: number
    positions: SimulationPositionCurrent[]
  }
  simulatedState: {
    equity: number
    unrealizedPnL: number
    totalPnL: number
    positions: SimulationPositionAfter[]
  }
  summary: {
    totalPnLChange: number
    equityChange: number
    equityChangePercent: string
    worstCase: string
  }
}
