/**
 * TradingGit — Trading-as-Git implementation
 *
 * Unified git-like operation tracking for all trading accounts.
 * Merges crypto-trading/wallet/Wallet.ts and securities-trading/wallet/SecWallet.ts.
 */

import { createHash } from 'crypto'
import { appendFile, readFile } from 'fs/promises'
import type { ITradingGit, TradingGitConfig } from './interfaces.js'
import type {
  CommitHash,
  Operation,
  OperationResult,
  AddResult,
  CommitPrepareResult,
  PushResult,
  GitStatus,
  GitCommit,
  GitState,
  CommitLogEntry,
  GitExportState,
  GitArchiveMetadata,
  OperationSummary,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
  PlaceOrderParams,
  ClosePositionParams,
} from './types.js'

function generateCommitHash(content: object): CommitHash {
  const hash = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
  return hash.slice(0, 8)
}

export class TradingGit implements ITradingGit {
  private stagingArea: Operation[] = []
  private pendingMessage: string | null = null
  private pendingHash: CommitHash | null = null
  private commits: GitCommit[] = []
  private head: CommitHash | null = null
  private pendingOrderIndex = new Map<string, string>()
  private currentRound: number | undefined = undefined
  private readonly config: TradingGitConfig
  private readonly maxActiveCommits: number
  private archiveMetadata: GitArchiveMetadata = { archivedCount: 0, oldestHash: null, newestHash: null }

  constructor(config: TradingGitConfig) {
    this.config = config
    this.maxActiveCommits = config.maxActiveCommits ?? 200
  }

  // ==================== git add / commit / push ====================

  add(operation: Operation): AddResult {
    this.stagingArea.push(operation)
    return {
      staged: true,
      index: this.stagingArea.length - 1,
      operation,
    }
  }

  commit(message: string): CommitPrepareResult {
    if (this.stagingArea.length === 0) {
      throw new Error('Nothing to commit: staging area is empty')
    }

    const timestamp = new Date().toISOString()
    this.pendingHash = generateCommitHash({
      message,
      operations: this.stagingArea,
      timestamp,
      parentHash: this.head,
    })
    this.pendingMessage = message

    return {
      prepared: true,
      hash: this.pendingHash,
      message,
      operationCount: this.stagingArea.length,
    }
  }

  async push(): Promise<PushResult> {
    if (this.stagingArea.length === 0) {
      throw new Error('Nothing to push: staging area is empty')
    }
    if (this.pendingMessage === null || this.pendingHash === null) {
      throw new Error('Nothing to push: please commit first')
    }

    const operations = [...this.stagingArea]
    const message = this.pendingMessage
    const hash = this.pendingHash

    // Execute all operations
    const results: OperationResult[] = []
    for (const op of operations) {
      try {
        const raw = await this.config.executeOperation(op)
        results.push(this.parseOperationResult(op, raw))
      } catch (error) {
        results.push({
          action: op.action,
          success: false,
          status: 'rejected',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Snapshot state after execution
    const stateAfter = await this.config.getGitState()

    const commit: GitCommit = {
      hash,
      parentHash: this.head,
      message,
      operations,
      results,
      stateAfter,
      timestamp: new Date().toISOString(),
      round: this.currentRound,
    }

    this.commits.push(commit)
    this.head = hash
    this.applyPendingOrderResults(operations, results)

    await this.config.onCommit?.(this.exportState())
    await this.archiveIfNeeded()

    // Clear staging
    this.stagingArea = []
    this.pendingMessage = null
    this.pendingHash = null

    const filled = results.filter((r) => r.status === 'filled')
    const pending = results.filter((r) => r.status === 'pending')
    const rejected = results.filter((r) => r.status === 'rejected' || !r.success)

    return { hash, message, operationCount: operations.length, filled, pending, rejected }
  }

  // ==================== git log / show / status ====================

  log(options: { limit?: number; symbol?: string } = {}): CommitLogEntry[] {
    const { limit = 10, symbol } = options

    let commits = this.commits.slice().reverse()

    if (symbol) {
      commits = commits.filter((c) =>
        c.operations.some((op) => {
          if (op.action === 'placeOrder' || op.action === 'closePosition') return op.params.symbol === symbol
          if (op.action === 'syncOrders') return false
          return false
        }),
      )
    }

    commits = commits.slice(0, limit)

    // If we need more entries and archive exists, supplement from archive
    if (commits.length < limit && this.archiveMetadata.archivedCount > 0 && this.config.archivePath) {
      const needed = limit - commits.length
      const archived = this.readArchivedCommitsSync(needed)
      // Archived are oldest-first in file, reverse for newest-first
      const archivedReversed = archived.reverse()
      if (symbol) {
        const filtered = archivedReversed.filter((c) =>
          c.operations.some((op) => {
            if (op.action === 'placeOrder' || op.action === 'closePosition') return op.params.symbol === symbol
            return false
          }),
        )
        commits = commits.concat(filtered.slice(0, needed))
      } else {
        commits = commits.concat(archivedReversed.slice(0, needed))
      }
    }

    return commits.map((c) => ({
      hash: c.hash,
      parentHash: c.parentHash,
      message: c.message,
      timestamp: c.timestamp,
      round: c.round,
      operations: this.buildOperationSummaries(c, symbol),
    }))
  }

  private buildOperationSummaries(
    commit: GitCommit,
    filterSymbol?: string,
  ): OperationSummary[] {
    const summaries: OperationSummary[] = []

    for (let i = 0; i < commit.operations.length; i++) {
      const op = commit.operations[i]
      const result = commit.results[i]
      const symbol = this.extractOperationSymbol(op)

      if (filterSymbol && symbol !== filterSymbol) continue

      summaries.push({
        symbol,
        action: op.action,
        change: this.formatOperationChange(op, result),
        status: result?.status || 'rejected',
      })
    }

    return summaries
  }

  private extractOperationSymbol(op: Operation): string {
    switch (op.action) {
      case 'placeOrder': return op.params.symbol ?? 'unknown'
      case 'closePosition': return op.params.symbol ?? 'unknown'
      case 'modifyOrder': return 'unknown'
      case 'cancelOrder': return 'unknown'
      case 'syncOrders': return 'unknown'
    }
  }

  private formatOperationChange(op: Operation, result?: OperationResult): string {
    switch (op.action) {
      case 'placeOrder': {
        const { side, notional, qty, size, usd_size } = op.params
        const sizeStr = notional ? `$${notional}` : usd_size ? `$${usd_size}` : qty ? `${qty}` : size ? `${size}` : '?'

        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @${result.filledPrice}` : ''
          return `${side} ${sizeStr}${price}`
        }
        return `${side} ${sizeStr} (${result?.status || 'unknown'})`
      }

      case 'closePosition': {
        const closeQty = op.params.qty ?? op.params.size
        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @${result.filledPrice}` : ''
          const qtyStr = closeQty ? ` (partial: ${closeQty})` : ''
          return `closed${qtyStr}${price}`
        }
        return `close (${result?.status || 'unknown'})`
      }

      case 'modifyOrder': {
        const { orderId, ...changes } = op.params
        const changeKeys = Object.keys(changes).filter((k) => (changes as Record<string, unknown>)[k] != null)
        return `modified ${orderId} (${changeKeys.join(', ')})`
      }

      case 'cancelOrder':
        return `cancelled order ${op.params.orderId}`

      case 'syncOrders': {
        const status = result?.status || 'unknown'
        const price = result?.filledPrice ? ` @${result.filledPrice}` : ''
        return `synced → ${status}${price}`
      }
    }
  }

  show(hash: CommitHash): GitCommit | null {
    const found = this.commits.find((c) => c.hash === hash)
    if (found) return found

    // Fall back to archive
    if (this.archiveMetadata.archivedCount > 0 && this.config.archivePath) {
      const archived = this.readArchivedCommitsSync()
      return archived.find((c) => c.hash === hash) ?? null
    }

    return null
  }

  status(): GitStatus {
    return {
      staged: [...this.stagingArea],
      pendingMessage: this.pendingMessage,
      head: this.head,
      commitCount: this.commits.length,
    }
  }

  // ==================== Serialization ====================

  exportState(): GitExportState {
    const state: GitExportState = { commits: [...this.commits], head: this.head }
    if (this.archiveMetadata.archivedCount > 0) {
      state.archive = { ...this.archiveMetadata }
    }
    return state
  }

  static restore(state: GitExportState, config: TradingGitConfig): TradingGit {
    const git = new TradingGit(config)
    git.commits = [...state.commits]
    git.head = state.head
    if (state.archive) {
      git.archiveMetadata = { ...state.archive }
    }
    git.rebuildPendingOrderIndex()
    return git
  }

  setCurrentRound(round: number): void {
    this.currentRound = round
  }

  // ==================== Sync ====================

  async sync(updates: OrderStatusUpdate[], currentState: GitState): Promise<SyncResult> {
    if (updates.length === 0) {
      return { hash: this.head ?? '', updatedCount: 0, updates: [] }
    }

    const hash = generateCommitHash({
      updates,
      timestamp: new Date().toISOString(),
      parentHash: this.head,
    })

    const commit: GitCommit = {
      hash,
      parentHash: this.head,
      message: `[sync] ${updates.length} order(s) updated`,
      operations: [{ action: 'syncOrders', params: { orderIds: updates.map((u) => u.orderId) } }],
      results: updates.map((u) => ({
        action: 'syncOrders' as const,
        success: true,
        orderId: u.orderId,
        status: u.currentStatus,
        filledPrice: u.filledPrice,
        filledQty: u.filledQty,
      })),
      stateAfter: currentState,
      timestamp: new Date().toISOString(),
      round: this.currentRound,
    }

    this.commits.push(commit)
    this.head = hash
    this.applySyncUpdatesToPendingIndex(updates)

    await this.config.onCommit?.(this.exportState())
    await this.archiveIfNeeded()

    return { hash, updatedCount: updates.length, updates }
  }

  getPendingOrderIds(): Array<{ orderId: string; symbol: string }> {
    return Array.from(this.pendingOrderIndex.entries()).map(([orderId, symbol]) => ({
      orderId,
      symbol,
    }))
  }

  // ==================== Simulation ====================

  async simulatePriceChange(
    priceChanges: PriceChangeInput[],
  ): Promise<SimulatePriceChangeResult> {
    const state = await this.config.getGitState()
    const { positions, equity, unrealizedPnL, cash } = state

    const currentTotalPnL = cash > 0 ? ((equity - cash) / cash) * 100 : 0

    if (positions.length === 0) {
      return {
        success: true,
        currentState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, positions: [] },
        simulatedState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, positions: [] },
        summary: {
          totalPnLChange: 0,
          equityChange: 0,
          equityChangePercent: '0.0%',
          worstCase: 'No positions to simulate.',
        },
      }
    }

    // Parse price changes → target price map
    const priceMap = new Map<string, number>()

    for (const { symbol, change } of priceChanges) {
      const parsed = this.parsePriceChange(change)
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid change format for ${symbol}: "${change}". Use "@150" for absolute or "+10%" / "-5%" for relative.`,
          currentState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, positions: [] },
          simulatedState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, positions: [] },
          summary: { totalPnLChange: 0, equityChange: 0, equityChangePercent: '0.0%', worstCase: '' },
        }
      }

      if (symbol === 'all') {
        for (const pos of positions) {
          priceMap.set(pos.contract.symbol ?? 'unknown', this.applyPriceChange(pos.currentPrice, parsed.type, parsed.value))
        }
      } else {
        const pos = positions.find((p) => (p.contract.symbol ?? p.contract.aliceId) === symbol)
        if (pos) {
          priceMap.set(symbol, this.applyPriceChange(pos.currentPrice, parsed.type, parsed.value))
        }
      }
    }

    // Current state
    const currentPositions = positions.map((pos) => ({
      symbol: pos.contract.symbol ?? pos.contract.aliceId ?? 'unknown',
      side: pos.side,
      qty: pos.qty,
      avgEntryPrice: pos.avgEntryPrice,
      currentPrice: pos.currentPrice,
      unrealizedPnL: pos.unrealizedPnL,
      marketValue: pos.marketValue,
    }))

    // Simulated state
    let simulatedUnrealizedPnL = 0
    const simulatedPositions = positions.map((pos) => {
      const sym = pos.contract.symbol ?? pos.contract.aliceId ?? 'unknown'
      const simulatedPrice = priceMap.get(sym) ?? pos.currentPrice
      const priceChange = simulatedPrice - pos.currentPrice
      const priceChangePct = pos.currentPrice > 0 ? (priceChange / pos.currentPrice) * 100 : 0

      const newPnL =
        pos.side === 'long'
          ? (simulatedPrice - pos.avgEntryPrice) * pos.qty
          : (pos.avgEntryPrice - simulatedPrice) * pos.qty

      const pnlChange = newPnL - pos.unrealizedPnL
      simulatedUnrealizedPnL += newPnL

      return {
        symbol: sym,
        side: pos.side,
        qty: pos.qty,
        avgEntryPrice: pos.avgEntryPrice,
        simulatedPrice,
        unrealizedPnL: newPnL,
        marketValue: simulatedPrice * pos.qty,
        pnlChange,
        priceChangePercent: `${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`,
      }
    })

    const pnlDiff = simulatedUnrealizedPnL - unrealizedPnL
    const simulatedEquity = equity + pnlDiff
    const simulatedTotalPnL = cash > 0 ? ((simulatedEquity - cash) / cash) * 100 : 0
    const equityChangePct = equity > 0 ? (pnlDiff / equity) * 100 : 0

    const worst = simulatedPositions.reduce(
      (w, p) => (p.pnlChange < w.pnlChange ? p : w),
      simulatedPositions[0],
    )

    const worstCase =
      worst.pnlChange < 0
        ? `${worst.symbol} would lose $${Math.abs(worst.pnlChange).toFixed(2)} (${worst.priceChangePercent})`
        : 'All positions would profit or break even.'

    return {
      success: true,
      currentState: { equity, unrealizedPnL, totalPnL: currentTotalPnL, positions: currentPositions },
      simulatedState: {
        equity: simulatedEquity,
        unrealizedPnL: simulatedUnrealizedPnL,
        totalPnL: simulatedTotalPnL,
        positions: simulatedPositions,
      },
      summary: {
        totalPnLChange: pnlDiff,
        equityChange: pnlDiff,
        equityChangePercent: `${equityChangePct >= 0 ? '+' : ''}${equityChangePct.toFixed(2)}%`,
        worstCase,
      },
    }
  }

  private parsePriceChange(
    change: string,
  ): { success: true; type: 'absolute' | 'relative'; value: number } | { success: false } {
    const trimmed = change.trim()

    if (trimmed.startsWith('@')) {
      const value = parseFloat(trimmed.slice(1))
      if (isNaN(value) || value <= 0) return { success: false }
      return { success: true, type: 'absolute', value }
    }

    if (trimmed.endsWith('%')) {
      const value = parseFloat(trimmed.slice(0, -1))
      if (isNaN(value)) return { success: false }
      return { success: true, type: 'relative', value }
    }

    return { success: false }
  }

  private applyPriceChange(
    currentPrice: number,
    type: 'absolute' | 'relative',
    value: number,
  ): number {
    return type === 'absolute' ? value : currentPrice * (1 + value / 100)
  }

  private rebuildPendingOrderIndex(): void {
    this.pendingOrderIndex.clear()
    for (const commit of this.commits) {
      this.applyPendingOrderResults(commit.operations, commit.results)
    }
  }

  private applyPendingOrderResults(operations: Operation[], results: OperationResult[]): void {
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (!result.orderId) continue

      if (result.status === 'pending') {
        const op = operations[i]
        const symbol =
          (op && (op.action === 'placeOrder' || op.action === 'closePosition') ? op.params.symbol : undefined) ??
          this.pendingOrderIndex.get(result.orderId) ??
          'unknown'
        this.pendingOrderIndex.set(result.orderId, symbol)
      } else {
        this.pendingOrderIndex.delete(result.orderId)
      }
    }
  }

  private applySyncUpdatesToPendingIndex(updates: OrderStatusUpdate[]): void {
    for (const update of updates) {
      if (update.currentStatus === 'pending') {
        this.pendingOrderIndex.set(update.orderId, update.symbol)
      } else {
        this.pendingOrderIndex.delete(update.orderId)
      }
    }
  }

  // ==================== Archive ====================

  private async archiveIfNeeded(): Promise<void> {
    if (!this.config.archivePath) return
    if (this.commits.length <= this.maxActiveCommits) return

    const overflow = this.commits.length - this.maxActiveCommits
    const toArchive = this.commits.splice(0, overflow)

    const lines = toArchive.map((c) => JSON.stringify(c)).join('\n') + '\n'
    await appendFile(this.config.archivePath, lines)

    this.archiveMetadata = {
      archivedCount: this.archiveMetadata.archivedCount + toArchive.length,
      oldestHash: this.archiveMetadata.oldestHash ?? toArchive[0].hash,
      newestHash: toArchive[toArchive.length - 1].hash,
    }
  }

  private readArchivedCommitsSync(limit?: number): GitCommit[] {
    if (!this.config.archivePath) return []
    try {
      const { readFileSync } = require('fs') as typeof import('fs')
      const content = readFileSync(this.config.archivePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const commits: GitCommit[] = []
      // Read from end (newest archived) when limit is set
      const start = limit ? Math.max(0, lines.length - limit) : 0
      for (let i = start; i < lines.length; i++) {
        try {
          commits.push(JSON.parse(lines[i]) as GitCommit)
        } catch { /* skip malformed lines */ }
      }
      return commits
    } catch {
      return []
    }
  }

  // ==================== Internal ====================

  private parseOperationResult(op: Operation, raw: unknown): OperationResult {
    const rawObj = raw as Record<string, unknown>

    if (!rawObj || typeof rawObj !== 'object') {
      return {
        action: op.action,
        success: false,
        status: 'rejected',
        error: 'Invalid response from trading engine',
        raw,
      }
    }

    const success = rawObj.success === true
    const order = rawObj.order as Record<string, unknown> | undefined

    if (!success) {
      return {
        action: op.action,
        success: false,
        status: 'rejected',
        error: (rawObj.error as string) ?? 'Unknown error',
        raw,
      }
    }

    if (!order) {
      // Operations without an order result
      return { action: op.action, success: true, status: 'filled', raw }
    }

    const status = order.status as string
    const isFilled = status === 'filled'
    const isPending = status === 'pending'

    return {
      action: op.action,
      success: true,
      orderId: order.id as string | undefined,
      status: isFilled ? 'filled' : isPending ? 'pending' : 'rejected',
      filledPrice: isFilled ? (order.filledPrice as number) : undefined,
      filledQty: isFilled
        ? ((order.filledQty ?? order.filledQuantity ?? order.qty ?? order.size) as number)
        : undefined,
      raw,
    }
  }
}
