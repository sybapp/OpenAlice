/**
 * Unified Operation Dispatcher
 *
 * Bridges TradingGit's Operation -> ITradingAccount method calls.
 * Used as the TradingGitConfig.executeOperation callback.
 *
 * Return values match the structure expected by TradingGit.parseOperationResult:
 * - placeOrder/modifyOrder/closePosition: { success, order?: { id, status, filledPrice, filledQty } }
 * - cancelOrder: { success, error? }
 */

import type { Contract } from './contract.js'
import type { SecType } from './contract.js'
import type {
  ITradingAccount,
  Order,
  OrderRequest,
  Position,
} from './interfaces.js'
import type { Operation, PlaceOrderParams, PersistedProtectionWatcher } from './git/types.js'

interface ProtectionPlan {
  stopLossPrice?: number
  stopLossPct?: number
  takeProfitPrice?: number
  takeProfitPct?: number
  takeProfitSizeRatio?: number
}

type ProtectionKind = 'stop' | 'take_profit'

const PROTECTION_WATCH_INTERVAL_MS = 3000
const PROTECTION_WATCH_TIMEOUT_MS = 6 * 60 * 60 * 1000
const PROTECTION_INTENT_TTL_MS = 6 * 60 * 60 * 1000
const PRICE_EPSILON = 0.0002
const QTY_EPSILON = 0.001

interface ProtectionIntent {
  contractRef: Partial<Contract>
  kind: ProtectionKind
  side: 'buy' | 'sell'
  triggerPrice: number
  qty: number
  orderId?: string
  updatedAt: number
}

const protectionIntentByAccount = new WeakMap<ITradingAccount, Map<string, ProtectionIntent>>()
const protectionLockByAccount = new WeakMap<ITradingAccount, Map<string, Promise<void>>>()

function protectionLockMap(account: ITradingAccount): Map<string, Promise<void>> {
  let map = protectionLockByAccount.get(account)
  if (!map) { map = new Map(); protectionLockByAccount.set(account, map) }
  return map
}

async function withProtectionLock<T>(
  account: ITradingAccount,
  contractRef: Partial<Contract>,
  kind: ProtectionKind,
  fn: () => Promise<T>,
): Promise<T> {
  const key = protectionIntentKey(contractRef, kind)
  if (!key) return fn()
  const locks = protectionLockMap(account)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => { release = r })
  locks.set(key, next)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next) locks.delete(key)
  }
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isFiniteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

function approxEqual(a: number | undefined, b: number | undefined, epsilonRatio: number): boolean {
  if (!isFinitePositive(a) || !isFinitePositive(b)) return false
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) <= scale * epsilonRatio
}

function protectionIntentKey(ref: Partial<Contract>, kind: ProtectionKind): string | null {
  const base = ref.aliceId ?? ref.symbol
  return base ? `${base}::${kind}` : null
}

function protectionIntentMap(account: ITradingAccount): Map<string, ProtectionIntent> {
  let map = protectionIntentByAccount.get(account)
  if (!map) {
    map = new Map()
    protectionIntentByAccount.set(account, map)
  }
  return map
}

function readProtectionIntent(
  account: ITradingAccount,
  contractRef: Partial<Contract>,
  kind: ProtectionKind,
): ProtectionIntent | undefined {
  const key = protectionIntentKey(contractRef, kind)
  if (!key) return undefined

  const intent = protectionIntentMap(account).get(key)
  if (!intent) return undefined
  if ((Date.now() - intent.updatedAt) > PROTECTION_INTENT_TTL_MS) {
    protectionIntentMap(account).delete(key)
    return undefined
  }
  return intent
}

function writeProtectionIntent(
  account: ITradingAccount,
  contractRef: Partial<Contract>,
  kind: ProtectionKind,
  intent: Omit<ProtectionIntent, 'contractRef' | 'kind' | 'updatedAt'>,
): void {
  const key = protectionIntentKey(contractRef, kind)
  if (!key) return

  protectionIntentMap(account).set(key, {
    contractRef,
    kind,
    ...intent,
    updatedAt: Date.now(),
  })
}

function clearProtectionIntent(
  account: ITradingAccount,
  contractRef: Partial<Contract>,
  kind?: ProtectionKind,
): void {
  if (kind) {
    const key = protectionIntentKey(contractRef, kind)
    if (key) protectionIntentMap(account).delete(key)
    return
  }

  for (const candidate of ['stop', 'take_profit'] as const) {
    const key = protectionIntentKey(contractRef, candidate)
    if (key) protectionIntentMap(account).delete(key)
  }
}

function clearProtectionIntentByOrderId(account: ITradingAccount, orderId: string): void {
  for (const [key, intent] of protectionIntentMap(account)) {
    if (intent.orderId === orderId) {
      protectionIntentMap(account).delete(key)
    }
  }
}

function readProtectionPlanFromTyped(params: PlaceOrderParams): ProtectionPlan | undefined {
  const raw = params.protection
  if (!raw) return undefined

  const plan: ProtectionPlan = {}

  if (isFinitePositive(raw.stopLossPrice)) plan.stopLossPrice = raw.stopLossPrice
  if (isFinitePositive(raw.stopLossPct)) plan.stopLossPct = raw.stopLossPct
  if (isFinitePositive(raw.takeProfitPrice)) plan.takeProfitPrice = raw.takeProfitPrice
  if (isFinitePositive(raw.takeProfitPct)) plan.takeProfitPct = raw.takeProfitPct
  if (isFiniteRatio(raw.takeProfitSizeRatio)) plan.takeProfitSizeRatio = raw.takeProfitSizeRatio

  if (
    plan.stopLossPrice === undefined &&
    plan.stopLossPct === undefined &&
    plan.takeProfitPrice === undefined &&
    plan.takeProfitPct === undefined
  ) {
    return undefined
  }

  return plan
}

function contractMatches(ref: Partial<Contract>, contract: Contract): boolean {
  if (ref.aliceId && contract.aliceId === ref.aliceId) return true
  if (ref.symbol && contract.symbol === ref.symbol) return true
  return false
}

function findPosition(ref: Partial<Contract>, positions: Position[]): Position | undefined {
  return positions.find((position) => contractMatches(ref, position.contract))
}

function classifyProtectionOrderType(order: Order): ProtectionKind | null {
  const type = String(order.type ?? '').toLowerCase()
  if (type.includes('take') && type.includes('profit')) return 'take_profit'
  if (type.includes('stop')) return 'stop'
  return null
}

function getOrderTriggerPrice(order: Order): number | undefined {
  if (isFinitePositive(order.stopPrice)) return order.stopPrice
  if (isFinitePositive(order.price)) return order.price
  return undefined
}

function sideForProtection(position: Position): 'buy' | 'sell' {
  return position.side === 'long' ? 'sell' : 'buy'
}

function toContractRef(params: {
  aliceId?: string
  symbol?: string
  secType?: string
  currency?: string
  exchange?: string
}): Partial<Contract> {
  const contract: Partial<Contract> = {}
  if (params.aliceId) contract.aliceId = params.aliceId
  if (params.symbol) contract.symbol = params.symbol
  if (params.secType) contract.secType = params.secType as unknown as SecType
  if (params.currency) contract.currency = params.currency
  if (params.exchange) contract.exchange = params.exchange
  return contract
}

function toOrderResult(result: {
  success: boolean
  error?: string
  orderId?: string
  filledPrice?: number
  filledQty?: number
}, status: 'pending' | 'filled' | 'partially_filled') {
  return {
    success: result.success,
    error: result.error,
    order: result.success
      ? {
          id: result.orderId,
          status,
          filledPrice: result.filledPrice,
          filledQty: result.filledQty,
        }
      : undefined,
  }
}

function buildModifyOrderChanges(params: {
  qty?: number
  price?: number
  stopPrice?: number
  trailingAmount?: number
  trailingPercent?: number
  type?: OrderRequest['type']
  timeInForce?: OrderRequest['timeInForce']
  goodTillDate?: string
}): Partial<OrderRequest> {
  const changes: Partial<OrderRequest> = {}
  if (params.qty != null) changes.qty = params.qty
  if (params.price != null) changes.price = params.price
  if (params.stopPrice != null) changes.stopPrice = params.stopPrice
  if (params.trailingAmount != null) changes.trailingAmount = params.trailingAmount
  if (params.trailingPercent != null) changes.trailingPercent = params.trailingPercent
  if (params.type) changes.type = params.type
  if (params.timeInForce) changes.timeInForce = params.timeInForce
  if (params.goodTillDate) changes.goodTillDate = params.goodTillDate
  return changes
}

function computeStopLossPrice(plan: ProtectionPlan, position: Position, entryPrice: number): number | undefined {
  if (isFinitePositive(plan.stopLossPrice)) return plan.stopLossPrice
  if (!isFinitePositive(plan.stopLossPct)) return undefined

  const ratio = plan.stopLossPct / 100
  return position.side === 'long'
    ? entryPrice * (1 - ratio)
    : entryPrice * (1 + ratio)
}

function computeTakeProfitPrice(plan: ProtectionPlan, position: Position, entryPrice: number): number | undefined {
  if (isFinitePositive(plan.takeProfitPrice)) return plan.takeProfitPrice
  if (!isFinitePositive(plan.takeProfitPct)) return undefined

  const ratio = plan.takeProfitPct / 100
  return position.side === 'long'
    ? entryPrice * (1 + ratio)
    : entryPrice * (1 - ratio)
}

async function upsertProtectionOrder(args: {
  account: ITradingAccount
  contract: Contract
  side: 'buy' | 'sell'
  triggerPrice: number
  qty: number
  kind: ProtectionKind
}): Promise<void> {
  const { account, contract, side, triggerPrice, qty, kind } = args

  return withProtectionLock(account, contract, kind, async () => {
    const recentIntent = readProtectionIntent(account, contract, kind)
    if (
      recentIntent &&
      recentIntent.side === side &&
      approxEqual(recentIntent.triggerPrice, triggerPrice, PRICE_EPSILON) &&
      approxEqual(recentIntent.qty, qty, QTY_EPSILON)
    ) {
      return
    }

    let pendingSameKind: Order[] = []
    try {
      const orders = await account.getOrders()
      pendingSameKind = orders.filter((order) => (
        order.status === 'pending' &&
        order.reduceOnly === true &&
        contractMatches(contract, order.contract) &&
        classifyProtectionOrderType(order) === kind
      ))
    } catch {
      pendingSameKind = []
    }

    const existing = pendingSameKind.find((order) => (
      order.side === side &&
      approxEqual(getOrderTriggerPrice(order), triggerPrice, PRICE_EPSILON) &&
      approxEqual(order.qty, qty, QTY_EPSILON)
    ))

    if (existing) {
      writeProtectionIntent(account, contract, kind, {
        side,
        triggerPrice,
        qty,
        orderId: existing.id,
      })
      return
    }

    clearProtectionIntent(account, contract, kind)

    for (const order of pendingSameKind) {
      try {
        await account.cancelOrder(order.id)
      } catch {
        console.warn(`protection: failed to cancel stale ${kind} order ${order.id}`)
      }
    }

    const result = await account.placeOrder({
      contract,
      side,
      type: kind,
      qty,
      stopPrice: triggerPrice,
      reduceOnly: true,
      timeInForce: 'gtc',
    })

    if (result.success) {
      writeProtectionIntent(account, contract, kind, {
        side,
        triggerPrice,
        qty,
        orderId: result.orderId,
      })
    }
  })
}

async function armProtectionForPosition(args: {
  account: ITradingAccount
  contractRef: Partial<Contract>
  plan: ProtectionPlan
  fillPriceHint?: number
  filledQty?: number
}): Promise<void> {
  const { account, contractRef, plan, fillPriceHint, filledQty } = args

  const positions = await account.getPositions()
  const position = findPosition(contractRef, positions)
  if (!position) {
    clearProtectionIntent(account, contractRef)
    return
  }

  const entryPrice = isFinitePositive(fillPriceHint) ? fillPriceHint : position.avgEntryPrice
  if (!isFinitePositive(entryPrice)) return

  const stopPrice = computeStopLossPrice(plan, position, entryPrice)
  const takeProfitPrice = computeTakeProfitPrice(plan, position, entryPrice)
  const protectionSide = sideForProtection(position)

  const protectionQty = isFinitePositive(filledQty) ? filledQty : position.qty

  if (isFinitePositive(stopPrice)) {
    await upsertProtectionOrder({
      account,
      contract: position.contract,
      side: protectionSide,
      triggerPrice: stopPrice,
      qty: protectionQty,
      kind: 'stop',
    })
  }

  const tpRatio = plan.takeProfitSizeRatio ?? 1
  const tpQty = protectionQty * tpRatio
  if (isFinitePositive(takeProfitPrice) && isFinitePositive(tpQty)) {
    await upsertProtectionOrder({
      account,
      contract: position.contract,
      side: protectionSide,
      triggerPrice: takeProfitPrice,
      qty: tpQty,
      kind: 'take_profit',
    })
  }
}

export interface DispatcherHandle {
  dispatch: (op: Operation) => Promise<unknown>
  getWatchers(): PersistedProtectionWatcher[]
  restoreWatchers(watchers: PersistedProtectionWatcher[]): void
  dispose(): void
}

interface DispatcherOptions {
  onWatchersChanged?: (watchers: PersistedProtectionWatcher[]) => void | Promise<void>
}

export function createOperationDispatcher(
  account: ITradingAccount,
  options?: DispatcherOptions,
): DispatcherHandle {
  const protectionWatchers = new Map<string, {
    contractRef: Partial<Contract>
    plan: ProtectionPlan
    startedAt: number
  }>()
  let protectionPollTimer: ReturnType<typeof setInterval> | null = null
  let protectionPolling = false

  const getWatchers = (): PersistedProtectionWatcher[] => {
    const result: PersistedProtectionWatcher[] = []
    for (const [orderId, w] of protectionWatchers) {
      result.push({
        orderId,
        contractRef: {
          aliceId: w.contractRef.aliceId,
          symbol: w.contractRef.symbol,
          secType: w.contractRef.secType,
        },
        plan: w.plan,
        startedAt: w.startedAt,
      })
    }
    return result
  }

  const notifyWatchersChanged = () => {
    void options?.onWatchersChanged?.(getWatchers())
  }

  const stopProtectionWatch = (orderId: string) => {
    if (!protectionWatchers.delete(orderId)) return

    if (protectionWatchers.size === 0 && protectionPollTimer) {
      clearInterval(protectionPollTimer)
      protectionPollTimer = null
    }
    notifyWatchersChanged()
  }

  const pollProtectionWatchers = async () => {
    if (protectionPolling || protectionWatchers.size === 0) return

    protectionPolling = true
    try {
      const now = Date.now()
      const orders = await account.getOrders()
      const ordersById = new Map(orders.map((order) => [order.id, order]))
      const settledOrderIds: string[] = []

      for (const [orderId, watcher] of protectionWatchers) {
        if (now - watcher.startedAt > PROTECTION_WATCH_TIMEOUT_MS) {
          settledOrderIds.push(orderId)
          continue
        }

        const order = ordersById.get(orderId)
        if (!order) continue

        if (order.status === 'cancelled' || order.status === 'rejected') {
          settledOrderIds.push(orderId)
          continue
        }

        if (order.status === 'filled') {
          await armProtectionForPosition({
            account,
            contractRef: watcher.contractRef,
            plan: watcher.plan,
            fillPriceHint: order.filledPrice ?? order.price,
            filledQty: order.filledQty,
          })
          settledOrderIds.push(orderId)
        }
      }

      for (const orderId of settledOrderIds) {
        stopProtectionWatch(orderId)
      }
    } catch {
      // Keep watching on intermittent broker/data errors.
    } finally {
      protectionPolling = false
    }
  }

  const ensureProtectionPoller = () => {
    if (protectionPollTimer) return

    protectionPollTimer = setInterval(() => {
      void pollProtectionWatchers()
    }, PROTECTION_WATCH_INTERVAL_MS)
    ;(protectionPollTimer as { unref?: () => void }).unref?.()
  }

  const startProtectionWatch = (args: {
    orderId: string
    contractRef: Partial<Contract>
    plan: ProtectionPlan
  }) => {
    const { orderId, contractRef, plan } = args
    if (protectionWatchers.has(orderId)) return

    protectionWatchers.set(orderId, {
      contractRef,
      plan,
      startedAt: Date.now(),
    })

    ensureProtectionPoller()
    notifyWatchersChanged()
    void pollProtectionWatchers()
  }

  const restoreWatchers = (watchers: PersistedProtectionWatcher[]): void => {
    for (const w of watchers) {
      if (protectionWatchers.has(w.orderId)) continue
      // Skip expired watchers
      if (Date.now() - w.startedAt > PROTECTION_WATCH_TIMEOUT_MS) continue
      protectionWatchers.set(w.orderId, {
        contractRef: w.contractRef,
        plan: w.plan,
        startedAt: w.startedAt,
      })
    }
    if (protectionWatchers.size > 0) {
      ensureProtectionPoller()
      void pollProtectionWatchers()
    }
    notifyWatchersChanged()
  }

  const dispose = (): void => {
    if (protectionPollTimer) {
      clearInterval(protectionPollTimer)
      protectionPollTimer = null
    }
    protectionWatchers.clear()
    notifyWatchersChanged()
  }

  const dispatch = async (op: Operation): Promise<unknown> => {
    switch (op.action) {
      case 'placeOrder': {
        const p = op.params
        const contract = toContractRef(p)

        const request: OrderRequest = {
          contract: contract as Contract,
          side: p.side,
          type: p.type,
          qty: p.qty,
          notional: p.notional,
          price: p.price,
          stopPrice: p.stopPrice,
          trailingAmount: p.trailingAmount,
          trailingPercent: p.trailingPercent,
          reduceOnly: p.reduceOnly,
          timeInForce: p.timeInForce ?? 'day',
          goodTillDate: p.goodTillDate,
          extendedHours: p.extendedHours,
          parentId: p.parentId,
          ocaGroup: p.ocaGroup,
        }

        const protectionKind =
          request.reduceOnly === true && request.type === 'stop'
            ? 'stop'
            : request.reduceOnly === true && request.type === 'take_profit'
              ? 'take_profit'
              : null

        if (protectionKind && isFinitePositive(request.stopPrice) && isFinitePositive(request.qty)) {
          const recentIntent = readProtectionIntent(account, contract, protectionKind)
          if (
            recentIntent &&
            recentIntent.side === request.side &&
            approxEqual(recentIntent.triggerPrice, request.stopPrice, PRICE_EPSILON) &&
            approxEqual(recentIntent.qty, request.qty, QTY_EPSILON)
          ) {
            return {
              success: true,
              error: undefined,
              order: {
                id: recentIntent.orderId,
                status: 'pending',
                filledPrice: undefined,
                filledQty: undefined,
              },
            }
          }
        }

        const result = await account.placeOrder(request)

        if (protectionKind && result.success && isFinitePositive(request.stopPrice) && isFinitePositive(request.qty)) {
          writeProtectionIntent(account, contract, protectionKind, {
            side: request.side,
            triggerPrice: request.stopPrice,
            qty: request.qty,
            orderId: result.orderId,
          })
        }

        const protectionPlan = readProtectionPlanFromTyped(p)
        const shouldArmProtection =
          result.success &&
          protectionPlan &&
          request.reduceOnly !== true &&
          (request.type === 'market' || request.type === 'limit')

        if (shouldArmProtection) {
          if (isFinitePositive(result.filledPrice)) {
            void armProtectionForPosition({
              account,
              contractRef: contract,
              plan: protectionPlan,
              fillPriceHint: result.filledPrice,
              filledQty: result.filledQty,
            })
          } else if (result.orderId) {
            startProtectionWatch({
              orderId: result.orderId,
              contractRef: contract,
              plan: protectionPlan,
            })
          }
        }

        const status = result.filledPrice
          ? (result.filledQty && request.qty && result.filledQty < request.qty
              ? 'partially_filled'
              : 'filled')
          : 'pending'

        return toOrderResult(result, status)
      }

      case 'modifyOrder': {
        const result = await account.modifyOrder(
          op.params.orderId,
          buildModifyOrderChanges(op.params),
        )
        return toOrderResult(result, result.filledPrice ? 'filled' : 'pending')
      }

      case 'closePosition': {
        const p = op.params
        const contract = toContractRef(p)

        const result = await account.closePosition(contract as Contract, p.qty)
        if (result.success) {
          clearProtectionIntent(account, contract)
        }

        return toOrderResult(result, result.filledPrice ? 'filled' : 'pending')
      }

      case 'cancelOrder': {
        const success = await account.cancelOrder(op.params.orderId)
        if (success) {
          clearProtectionIntentByOrderId(account, op.params.orderId)
        }
        return { success, error: success ? undefined : 'Failed to cancel order' }
      }

      default:
        throw new Error(`Unknown operation action: ${op.action}`)
    }
  }

  return { dispatch, getWatchers, restoreWatchers, dispose }
}
