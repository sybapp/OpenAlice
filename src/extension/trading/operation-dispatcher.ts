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
import type {
  ITradingAccount,
  Order,
  OrderRequest,
  OrderType,
  Position,
  TimeInForce,
} from './interfaces.js'
import type { Operation } from './git/types.js'

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

function readProtectionPlan(params: Record<string, unknown>): ProtectionPlan | undefined {
  const raw = params.protection
  if (!raw || typeof raw !== 'object') return undefined

  const candidate = raw as Record<string, unknown>
  const plan: ProtectionPlan = {}

  if (isFinitePositive(candidate.stopLossPrice)) plan.stopLossPrice = candidate.stopLossPrice
  if (isFinitePositive(candidate.stopLossPct)) plan.stopLossPct = candidate.stopLossPct
  if (isFinitePositive(candidate.takeProfitPrice)) plan.takeProfitPrice = candidate.takeProfitPrice
  if (isFinitePositive(candidate.takeProfitPct)) plan.takeProfitPct = candidate.takeProfitPct
  if (isFiniteRatio(candidate.takeProfitSizeRatio)) plan.takeProfitSizeRatio = candidate.takeProfitSizeRatio

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
      // Best-effort cleanup before placing the replacement protection order.
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
}

async function armProtectionForPosition(args: {
  account: ITradingAccount
  contractRef: Partial<Contract>
  plan: ProtectionPlan
  fillPriceHint?: number
}): Promise<void> {
  const { account, contractRef, plan, fillPriceHint } = args

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

  if (isFinitePositive(stopPrice)) {
    await upsertProtectionOrder({
      account,
      contract: position.contract,
      side: protectionSide,
      triggerPrice: stopPrice,
      qty: position.qty,
      kind: 'stop',
    })
  }

  const tpRatio = plan.takeProfitSizeRatio ?? 1
  const tpQty = position.qty * tpRatio
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

export function createOperationDispatcher(account: ITradingAccount) {
  const protectionWatchers = new Map<string, {
    contractRef: Partial<Contract>
    plan: ProtectionPlan
    startedAt: number
  }>()
  let protectionPollTimer: ReturnType<typeof setInterval> | null = null
  let protectionPolling = false

  const stopProtectionWatch = (orderId: string) => {
    if (!protectionWatchers.delete(orderId)) return

    if (protectionWatchers.size === 0 && protectionPollTimer) {
      clearInterval(protectionPollTimer)
      protectionPollTimer = null
    }
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
    void pollProtectionWatchers()
  }

  return async (op: Operation): Promise<unknown> => {
    switch (op.action) {
      case 'placeOrder': {
        const contract: Partial<Contract> = {}
        if (op.params.aliceId) contract.aliceId = op.params.aliceId as string
        if (op.params.symbol) contract.symbol = op.params.symbol as string
        if (op.params.secType) contract.secType = op.params.secType as Contract['secType']
        if (op.params.currency) contract.currency = op.params.currency as string
        if (op.params.exchange) contract.exchange = op.params.exchange as string

        const request: OrderRequest = {
          contract: contract as Contract,
          side: op.params.side as 'buy' | 'sell',
          type: op.params.type as OrderType,
          qty: op.params.qty as number | undefined,
          notional: op.params.notional as number | undefined,
          price: op.params.price as number | undefined,
          stopPrice: op.params.stopPrice as number | undefined,
          trailingAmount: op.params.trailingAmount as number | undefined,
          trailingPercent: op.params.trailingPercent as number | undefined,
          reduceOnly: op.params.reduceOnly as boolean | undefined,
          timeInForce: (op.params.timeInForce as TimeInForce) ?? 'day',
          goodTillDate: op.params.goodTillDate as string | undefined,
          extendedHours: op.params.extendedHours as boolean | undefined,
          parentId: op.params.parentId as string | undefined,
          ocaGroup: op.params.ocaGroup as string | undefined,
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

        const protectionPlan = readProtectionPlan(op.params)
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
            })
          } else if (result.orderId) {
            startProtectionWatch({
              orderId: result.orderId,
              contractRef: contract,
              plan: protectionPlan,
            })
          }
        }

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQty: result.filledQty,
              }
            : undefined,
        }
      }

      case 'modifyOrder': {
        const orderId = op.params.orderId as string
        const changes: Partial<OrderRequest> = {}
        if (op.params.qty != null) changes.qty = op.params.qty as number
        if (op.params.price != null) changes.price = op.params.price as number
        if (op.params.stopPrice != null) changes.stopPrice = op.params.stopPrice as number
        if (op.params.trailingAmount != null) changes.trailingAmount = op.params.trailingAmount as number
        if (op.params.trailingPercent != null) changes.trailingPercent = op.params.trailingPercent as number
        if (op.params.type) changes.type = op.params.type as OrderType
        if (op.params.timeInForce) changes.timeInForce = op.params.timeInForce as TimeInForce
        if (op.params.goodTillDate) changes.goodTillDate = op.params.goodTillDate as string

        const result = await account.modifyOrder(orderId, changes)

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQty: result.filledQty,
              }
            : undefined,
        }
      }

      case 'closePosition': {
        const contract: Partial<Contract> = {}
        if (op.params.aliceId) contract.aliceId = op.params.aliceId as string
        if (op.params.symbol) contract.symbol = op.params.symbol as string
        if (op.params.secType) contract.secType = op.params.secType as Contract['secType']

        const qty = op.params.qty as number | undefined
        const result = await account.closePosition(contract as Contract, qty)
        if (result.success) {
          clearProtectionIntent(account, contract)
        }

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQty: result.filledQty,
              }
            : undefined,
        }
      }

      case 'cancelOrder': {
        const orderId = op.params.orderId as string
        const success = await account.cancelOrder(orderId)
        if (success) {
          clearProtectionIntentByOrderId(account, orderId)
        }
        return { success, error: success ? undefined : 'Failed to cancel order' }
      }

      default:
        throw new Error(`Unknown operation action: ${op.action}`)
    }
  }
}
