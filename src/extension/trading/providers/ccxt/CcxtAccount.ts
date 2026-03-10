/**
 * CcxtAccount — ITradingAccount adapter for CCXT exchanges
 *
 * Direct implementation against ccxt unified API. No SymbolMapper —
 * contract resolution searches exchange.markets on demand.
 * aliceId format: "{exchange}-{market.id}" (e.g. "bybit-BTCUSDT").
 */

import ccxt from 'ccxt'
import type { Exchange, Order as CcxtOrder } from 'ccxt'
import type { Contract, ContractDescription, ContractDetails, SecType } from '../../contract.js'
import type {
  ITradingAccount,
  AccountCapabilities,
  AccountInfo,
  Position,
  Order,
  OrderRequest,
  OrderResult,
  Quote,
  MarketClock,
  FundingRate,
  OrderBook,
  OrderBookLevel,
} from '../../interfaces.js'
import type { CcxtAccountConfig, CcxtMarket } from './ccxt-types.js'
import { MAX_INIT_RETRIES, INIT_RETRY_BASE_MS } from './ccxt-types.js'
import {
  mapOrderStatus,
  marketToContract,
  contractToCcxt,
} from './ccxt-contracts.js'

const PROTECTION_PRICE_EPSILON = 0.0002
const PROTECTION_QTY_EPSILON = 0.001

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function approxEqual(a: number | undefined, b: number | undefined, epsilonRatio: number): boolean {
  if (!isFinitePositive(a) || !isFinitePositive(b)) return false
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) <= scale * epsilonRatio
}

export class CcxtAccount implements ITradingAccount {
  private static readonly POSITIONS_CACHE_TTL_MS = 1000
  private static readonly ORDERS_CACHE_TTL_MS = 1000
  private static readonly PROTECTION_INTENT_TTL_MS = 6 * 60 * 60 * 1000

  readonly id: string
  readonly provider: string  // "ccxt" or the specific exchange name
  readonly label: string

  private exchange: Exchange
  private exchangeName: string
  private defaultMarketType: 'spot' | 'swap'
  private initialized = false
  private readonly readOnly: boolean

  // orderId → ccxtSymbol cache (CCXT needs symbol to cancel)
  private orderSymbolCache = new Map<string, string>()

  private positionsCache:
    | { at: number; raw: Awaited<ReturnType<Exchange['fetchPositions']>>; mapped: Position[] }
    | null = null
  private positionsInFlight:
    | Promise<{ raw: Awaited<ReturnType<Exchange['fetchPositions']>>; mapped: Position[] }>
    | null = null

  private ordersCache: { at: number; data: Order[] } | null = null
  private ordersInFlight: Promise<Order[]> | null = null

  private protectionIntentCache = new Map<string, {
    kind: 'stop' | 'take_profit'
    side: 'buy' | 'sell'
    triggerPrice: number
    qty: number
    orderId?: string
    updatedAt: number
  }>()

  constructor(config: CcxtAccountConfig) {
    this.exchangeName = config.exchange
    this.provider = config.exchange  // use exchange name as provider (e.g. "bybit", "binance")
    this.id = config.id ?? `${config.exchange}-main`
    this.label = config.label ?? `${config.exchange.charAt(0).toUpperCase() + config.exchange.slice(1)} ${config.sandbox ? 'Testnet' : 'Live'}`
    this.defaultMarketType = config.defaultMarketType
    this.readOnly = !config.apiKey || !config.apiSecret

    const exchanges = ccxt as unknown as Record<string, new (opts: Record<string, unknown>) => Exchange>
    const ExchangeClass = exchanges[config.exchange]
    if (!ExchangeClass) {
      throw new Error(`Unknown CCXT exchange: ${config.exchange}`)
    }

    // Default: skip option markets to reduce concurrent requests during loadMarkets
    // (bybit fires 6 parallel requests by default, which is unreliable through proxies)
    const defaultOptions: Record<string, unknown> = {
      fetchMarkets: { types: ['spot', 'linear', 'inverse'] },
    }
    const mergedOptions = { ...defaultOptions, ...config.options }

    this.exchange = new ExchangeClass({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      password: config.password,
      options: mergedOptions,
    })

    if (config.sandbox) {
      this.exchange.setSandboxMode(true)
    }

    if (config.demoTrading) {
      (this.exchange as unknown as { enableDemoTrading: (enable: boolean) => void }).enableDemoTrading(true)
    }
  }

  // ---- Helpers ----

  private get markets() {
    return this.exchange.markets as unknown as Record<string, CcxtMarket>
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error(`CcxtAccount[${this.id}] not initialized. Call init() first.`)
    }
  }

  private ensureWritable(): void {
    if (this.readOnly) {
      throw new Error(
        `CcxtAccount[${this.id}] is in read-only mode (no API keys). This operation requires authentication.`,
      )
    }
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    // CCXT's fetchMarkets fires all market-type requests via Promise.all —
    // a single failure kills the entire batch. Monkey-patch fetchMarkets to
    // run each type sequentially with per-type retries.
    const origFetchMarkets = this.exchange.fetchMarkets.bind(this.exchange)
    const accountId = this.id

    this.exchange.fetchMarkets = async (params?: Record<string, unknown>) => {
      const ex = this.exchange as unknown as Record<string, unknown>
      const opts = (ex['options'] ?? {}) as Record<string, unknown>
      const fmOpts = (opts['fetchMarkets'] ?? {}) as Record<string, unknown>
      const types = (fmOpts['types'] ?? ['spot', 'linear', 'inverse']) as string[]

      const allMarkets: unknown[] = []
      for (const type of types) {
        for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
          try {
            // Temporarily override types to load a single type
            const prevTypes = fmOpts['types']
            fmOpts['types'] = [type]
            const markets = await origFetchMarkets(params)
            fmOpts['types'] = prevTypes
            allMarkets.push(...markets)
            break
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (attempt < MAX_INIT_RETRIES) {
              const delay = INIT_RETRY_BASE_MS * Math.pow(2, attempt - 1)
              console.warn(`CcxtAccount[${accountId}]: fetchMarkets(${type}) attempt ${attempt}/${MAX_INIT_RETRIES} failed, retrying in ${delay}ms...`)
              await new Promise(r => setTimeout(r, delay))
            } else {
              console.warn(`CcxtAccount[${accountId}]: fetchMarkets(${type}) failed after ${MAX_INIT_RETRIES} attempts: ${msg} — skipping`)
            }
          }
        }
      }
      return allMarkets as Awaited<ReturnType<Exchange['fetchMarkets']>>
    }

    // Now loadMarkets will use our sequential fetchMarkets
    await this.exchange.loadMarkets()

    const marketCount = Object.keys(this.exchange.markets).length
    if (marketCount === 0) {
      throw new Error(`CcxtAccount[${this.id}]: failed to load any markets`)
    }
    this.initialized = true
    const mode = this.readOnly ? ', read-only (no API keys)' : ''
    console.log(`CcxtAccount[${this.id}]: connected (${this.exchangeName}, ${marketCount} markets loaded${mode})`)
  }

  async close(): Promise<void> {
    // CCXT exchanges typically don't need explicit closing
  }

  // ---- Contract search ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    this.ensureInit()
    if (!pattern) return []

    const searchBase = pattern.toUpperCase()
    const matchedMarkets: CcxtMarket[] = []

    for (const market of Object.values(this.markets)) {
      if (market.active === false) continue
      if (market.base.toUpperCase() !== searchBase) continue

      // Default filter: only USDT/USD/USDC quoted markets (skip exotic pairs)
      const quote = market.quote.toUpperCase()
      if (quote !== 'USDT' && quote !== 'USD' && quote !== 'USDC') continue

      matchedMarkets.push(market)
    }

    // Sort: preferred market type first, then USDT > USD > USDC
    const typeOrder = this.defaultMarketType === 'swap'
      ? { swap: 0, future: 1, spot: 2, option: 3 }
      : { spot: 0, swap: 1, future: 2, option: 3 }
    const quoteOrder: Record<string, number> = { USDT: 0, USD: 1, USDC: 2 }

    matchedMarkets.sort((a, b) => {
      const aType = typeOrder[a.type as keyof typeof typeOrder] ?? 99
      const bType = typeOrder[b.type as keyof typeof typeOrder] ?? 99
      if (aType !== bType) return aType - bType
      const aQuote = quoteOrder[a.quote.toUpperCase()] ?? 99
      const bQuote = quoteOrder[b.quote.toUpperCase()] ?? 99
      return aQuote - bQuote
    })

    // Collect derivative types available for this base asset
    const derivativeTypes = new Set<SecType>()
    for (const m of matchedMarkets) {
      if (m.type === 'future') derivativeTypes.add('FUT')
      if (m.type === 'option') derivativeTypes.add('OPT')
    }
    const derivativeSecTypes: SecType[] | undefined = derivativeTypes.size > 0
      ? Array.from(derivativeTypes)
      : undefined

    return matchedMarkets.map(market => ({
      contract: marketToContract(market, this.exchangeName),
      derivativeSecTypes,
    }))
  }

  async getContractDetails(query: Partial<Contract>): Promise<ContractDetails | null> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(query as Contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) return null

    const market = this.markets[ccxtSymbol]
    if (!market) return null

    return {
      contract: marketToContract(market, this.exchangeName),
      longName: `${market.base}/${market.quote} ${market.type}${market.settle ? ` (${market.settle} settled)` : ''}`,
      minTick: market.precision?.price,
    }
  }

  // ---- Trading operations ----

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.ensureInit()
    this.ensureWritable()

    const ccxtSymbol = contractToCcxt(order.contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) {
      return { success: false, error: 'Cannot resolve contract to CCXT symbol' }
    }

    let size = order.qty

    // Notional → size conversion
    if (!size && order.notional) {
      const ticker = await this.exchange.fetchTicker(ccxtSymbol)
      const price = order.price ?? ticker.last
      if (!price) {
        return { success: false, error: 'Cannot determine price for notional conversion' }
      }
      size = order.notional / price
    }

    if (!size) {
      return { success: false, error: 'Either qty or notional must be provided' }
    }

    const requiresPrice = order.type === 'limit' || order.type === 'stop_limit' || order.type === 'trailing_stop_limit'
    if (requiresPrice && order.price == null) {
      return { success: false, error: `Order type ${order.type} requires price` }
    }

    const requiresStopPrice = order.type === 'stop' || order.type === 'stop_limit'
    if (requiresStopPrice && order.stopPrice == null) {
      return { success: false, error: `Order type ${order.type} requires stopPrice` }
    }

    const requiresTrailing = order.type === 'trailing_stop' || order.type === 'trailing_stop_limit'
    if (requiresTrailing && order.trailingAmount == null && order.trailingPercent == null) {
      return { success: false, error: `Order type ${order.type} requires trailingAmount or trailingPercent` }
    }

    try {
      const protectionKind =
        order.reduceOnly && order.type === 'stop'
          ? 'stop'
          : order.reduceOnly && order.type === 'take_profit'
            ? 'take_profit'
            : null

      if (protectionKind) {
        const recentIntent = this.readProtectionIntent(order.contract, protectionKind)
        if (
          recentIntent &&
          recentIntent.side === order.side &&
          approxEqual(recentIntent.triggerPrice, order.stopPrice, PROTECTION_PRICE_EPSILON) &&
          approxEqual(recentIntent.qty, size, PROTECTION_QTY_EPSILON)
        ) {
          return {
            success: true,
            orderId: recentIntent.orderId,
            message: `${protectionKind} already armed (cached)`,
          }
        }

        try {
          const existingOrders = await this.getOrders()
          const protectionOrders = existingOrders.filter((existing) => {
            const existingKind =
              existing.type === 'take_profit'
                ? 'take_profit'
                : existing.type === 'stop'
                  ? 'stop'
                  : null

            return (
              existing.status === 'pending' &&
              existing.reduceOnly &&
              existingKind === protectionKind &&
              ((order.contract.aliceId && existing.contract.aliceId === order.contract.aliceId) ||
                (order.contract.symbol && existing.contract.symbol === order.contract.symbol))
            )
          })

          const identical = protectionOrders.find((existing) => (
            existing.side === order.side &&
            approxEqual(existing.stopPrice ?? existing.price, order.stopPrice, PROTECTION_PRICE_EPSILON) &&
            approxEqual(existing.qty, size, PROTECTION_QTY_EPSILON)
          ))
          if (identical) {
            this.writeProtectionIntent(order.contract, protectionKind, {
              side: order.side,
              triggerPrice: order.stopPrice ?? identical.stopPrice ?? identical.price ?? 0,
              qty: size,
              orderId: identical.id,
            })
            return {
              success: true,
              orderId: identical.id,
              message: `${protectionKind} already armed`,
            }
          }

          this.clearProtectionIntent(order.contract, protectionKind)
          for (const existing of protectionOrders) {
            try {
              await this.cancelOrder(existing.id)
            } catch {
              // Best-effort cleanup before replacing protection orders.
            }
          }
        } catch {
          // Non-fatal: continue even if existing protection orders cannot be listed.
        }
      }

      const params: Record<string, unknown> = {}
      if (order.reduceOnly) params.reduceOnly = true
      if (order.stopPrice != null) {
        params.stopPrice = order.stopPrice
        params.triggerPrice = order.stopPrice
      }
      if (order.trailingAmount != null) params.trailingAmount = order.trailingAmount
      if (order.trailingPercent != null) params.trailingPercent = order.trailingPercent

      const ccxtOrderType =
        order.type === 'stop'
          ? 'stop_market'
          : order.type === 'take_profit'
            ? 'take_profit_market'
            : order.type === 'trailing_stop'
              ? 'trailing_stop_market'
              : order.type === 'trailing_stop_limit'
                ? 'trailing_stop_limit'
                : order.type

      const priceArg =
        order.type === 'limit' || order.type === 'stop_limit' || order.type === 'trailing_stop_limit'
          ? order.price
          : order.type === 'stop' || order.type === 'take_profit'
            ? order.stopPrice
            : undefined

      const ccxtOrder = await this.exchange.createOrder(
        ccxtSymbol,
        ccxtOrderType,
        order.side,
        size,
        priceArg,
        params,
      )

      // Cache orderId → symbol
      if (ccxtOrder.id) {
        this.orderSymbolCache.set(ccxtOrder.id, ccxtSymbol)
      }

      if (protectionKind) {
        this.writeProtectionIntent(order.contract, protectionKind, {
          side: order.side,
          triggerPrice: order.stopPrice ?? 0,
          qty: size,
          orderId: ccxtOrder.id,
        })
      }

      this.invalidateOrderCache()
      this.invalidatePositionCache()

      const status = mapOrderStatus(ccxtOrder.status)

      return {
        success: true,
        orderId: ccxtOrder.id,
        message: `Order ${ccxtOrder.id} ${status}`,
        filledPrice: status === 'filled' ? (ccxtOrder.average ?? ccxtOrder.price ?? undefined) : undefined,
        filledQty: status === 'filled' ? (ccxtOrder.filled ?? undefined) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.ensureInit()
    this.ensureWritable()

    try {
      const ccxtSymbol = this.orderSymbolCache.get(orderId)

      if (this.exchange.id === 'binance' && ccxtSymbol) {
        const ex = this.exchange as Exchange & {
          market?: (symbol: string) => { id?: string }
          fapiPrivateDeleteAlgoOrder?: (params: { symbol: string; algoId: string }) => Promise<unknown>
        }
        const marketId = ex.market?.(ccxtSymbol)?.id
        if (marketId && typeof ex.fapiPrivateDeleteAlgoOrder === 'function') {
          try {
            await ex.fapiPrivateDeleteAlgoOrder({ symbol: marketId, algoId: orderId })
            this.clearProtectionIntentByOrderId(orderId)
            this.invalidateOrderCache()
            this.invalidatePositionCache()
            return true
          } catch {
            // Fall back to regular cancelOrder for non-algo orders.
          }
        }
      }

      await this.exchange.cancelOrder(orderId, ccxtSymbol)
      this.clearProtectionIntentByOrderId(orderId)
      this.invalidateOrderCache()
      this.invalidatePositionCache()
      return true
    } catch {
      return false
    }
  }

  async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<OrderResult> {
    this.ensureInit()
    this.ensureWritable()

    try {
      const ccxtSymbol = this.orderSymbolCache.get(orderId)
      if (!ccxtSymbol) {
        return { success: false, error: `Unknown order ${orderId} — cannot resolve symbol for edit` }
      }

      // editOrder requires type and side — fetch the original order to fill in defaults
      const original = await this.exchange.fetchOrder(orderId, ccxtSymbol)
      const result = await this.exchange.editOrder(
        orderId,
        ccxtSymbol,
        (changes.type as string) ?? original.type,
        original.side,
        changes.qty ?? original.amount,
        changes.price ?? original.price,
      )

      this.invalidateOrderCache()
      this.invalidatePositionCache()

      return {
        success: true,
        orderId: result.id,
        filledPrice: result.average ?? undefined,
        filledQty: result.filled ?? undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async closePosition(contract: Contract, qty?: number): Promise<OrderResult> {
    this.ensureInit()
    this.ensureWritable()

    const positions = await this.getPositions()
    const symbol = contract.symbol?.toUpperCase()
    const aliceId = contract.aliceId

    const pos = positions.find(p =>
      (aliceId && p.contract.aliceId === aliceId) ||
      (symbol && p.contract.symbol === symbol),
    )

    if (!pos) {
      return { success: false, error: `No open position for ${aliceId ?? symbol ?? 'unknown'}` }
    }

    const result = await this.placeOrder({
      contract: pos.contract,
      side: pos.side === 'long' ? 'sell' : 'buy',
      type: 'market',
      qty: qty ?? pos.qty,
      reduceOnly: true,
    })

    if (!result.success) {
      return result
    }

    try {
      const orders = await this.getOrders()
      const pending = orders.filter((o) =>
        o.status === 'pending' &&
        ((pos.contract.aliceId && o.contract.aliceId === pos.contract.aliceId) ||
          (pos.contract.symbol && o.contract.symbol === pos.contract.symbol)),
      )

      for (const order of pending) {
        try {
          await this.cancelOrder(order.id)
        } catch {
          // Best-effort cleanup after a successful close.
        }
      }
    } catch {
      // Best-effort cleanup failure should not make the close fail.
    }

    this.clearProtectionIntent(pos.contract)
    return result
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    this.ensureInit()
    this.ensureWritable()

    const balanceParams: Record<string, string> = {}
    if (this.defaultMarketType === 'swap') {
      balanceParams.type = 'swap'
    }

    const [balance, positionsSnapshot] = await Promise.all([
      this.exchange.fetchBalance(balanceParams),
      this.getPositionsSnapshot(),
    ])

    const bal = balance as unknown as Record<string, Record<string, unknown>>
    const total = parseFloat(String(bal['total']?.['USDT'] ?? bal['total']?.['USD'] ?? 0))
    const free = parseFloat(String(bal['free']?.['USDT'] ?? bal['free']?.['USD'] ?? 0))
    const used = parseFloat(String(bal['used']?.['USDT'] ?? bal['used']?.['USD'] ?? 0))

    let unrealizedPnL = 0
    let realizedPnL = 0
    for (const p of positionsSnapshot.raw) {
      unrealizedPnL += parseFloat(String(p.unrealizedPnl ?? 0))
      realizedPnL += parseFloat(String((p as unknown as Record<string, unknown>).realizedPnl ?? 0))
    }

    return {
      cash: free,
      equity: total,
      unrealizedPnL,
      realizedPnL,
      totalMargin: used,
    }
  }

  async getPositions(): Promise<Position[]> {
    this.ensureInit()
    this.ensureWritable()

    const snapshot = await this.getPositionsSnapshot()
    return snapshot.mapped.map((position) => ({
      ...position,
      contract: { ...position.contract },
    }))
  }

  async getOrders(): Promise<Order[]> {
    this.ensureInit()
    this.ensureWritable()

    const cached = this.ordersCache
    if (cached && (Date.now() - cached.at) < CcxtAccount.ORDERS_CACHE_TTL_MS) {
      return cached.data.map((order) => ({
        ...order,
        contract: { ...order.contract },
      }))
    }

    if (this.ordersInFlight) {
      const inFlightOrders = await this.ordersInFlight
      return inFlightOrders.map((order) => ({
        ...order,
        contract: { ...order.contract },
      }))
    }

    this.ordersInFlight = this.loadOrders()
    try {
      const orders = await this.ordersInFlight
      this.ordersCache = { at: Date.now(), data: orders }
      return orders.map((order) => ({
        ...order,
        contract: { ...order.contract },
      }))
    } finally {
      this.ordersInFlight = null
    }
  }

  private invalidatePositionCache(): void {
    this.positionsCache = null
  }

  private invalidateOrderCache(): void {
    this.ordersCache = null
  }

  private async getPositionsSnapshot(): Promise<{
    raw: Awaited<ReturnType<Exchange['fetchPositions']>>
    mapped: Position[]
  }> {
    const cached = this.positionsCache
    if (cached && (Date.now() - cached.at) < CcxtAccount.POSITIONS_CACHE_TTL_MS) {
      return cached
    }

    if (this.positionsInFlight) {
      return await this.positionsInFlight
    }

    this.positionsInFlight = this.loadPositionsSnapshot()
    try {
      const snapshot = await this.positionsInFlight
      this.positionsCache = {
        at: Date.now(),
        raw: snapshot.raw,
        mapped: snapshot.mapped,
      }
      return snapshot
    } finally {
      this.positionsInFlight = null
    }
  }

  private async loadPositionsSnapshot(): Promise<{
    raw: Awaited<ReturnType<Exchange['fetchPositions']>>
    mapped: Position[]
  }> {
    const raw = await this.exchange.fetchPositions()
    return { raw, mapped: this.mapPositions(raw) }
  }

  private mapPositions(raw: Awaited<ReturnType<Exchange['fetchPositions']>>): Position[] {
    const result: Position[] = []

    for (const p of raw) {
      const market = this.markets[p.symbol]
      if (!market) continue

      const size = Math.abs(parseFloat(String(p.contracts ?? 0)) * parseFloat(String(p.contractSize ?? 1)))
      if (size === 0) continue

      const markPrice = parseFloat(String(p.markPrice ?? 0))
      const entryPrice = parseFloat(String(p.entryPrice ?? 0))
      const marketValue = size * markPrice
      const costBasis = size * entryPrice
      const unrealizedPnL = parseFloat(String(p.unrealizedPnl ?? 0))

      result.push({
        contract: marketToContract(market, this.exchangeName),
        side: p.side === 'long' ? 'long' : 'short',
        qty: size,
        avgEntryPrice: entryPrice,
        currentPrice: markPrice,
        marketValue,
        unrealizedPnL,
        unrealizedPnLPercent: costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0,
        costBasis,
        leverage: parseFloat(String(p.leverage ?? 1)),
        margin: parseFloat(String(p.initialMargin ?? p.collateral ?? 0)),
        liquidationPrice: parseFloat(String(p.liquidationPrice ?? 0)) || undefined,
      })
    }

    return result
  }

  private async loadOrders(): Promise<Order[]> {
    const allOrders: CcxtOrder[] = []

    try {
      const open = await this.exchange.fetchOpenOrders()
      allOrders.push(...open)
    } catch {
      // Some exchanges don't support fetchOpenOrders
    }

    try {
      const closed = await this.exchange.fetchClosedOrders(undefined, undefined, 50)
      allOrders.push(...closed)
    } catch {
      // Some exchanges don't support fetchClosedOrders
    }

    const result: Order[] = []

    for (const o of allOrders) {
      const market = this.markets[o.symbol]
      if (!market) continue

      if (o.id) {
        this.orderSymbolCache.set(o.id, o.symbol)
      }

      const rawType = String(o.type ?? 'market').toLowerCase()
      const orderType: Order['type'] =
        rawType.includes('take') && rawType.includes('profit')
          ? 'take_profit'
          : rawType.includes('stop')
            ? 'stop'
            : (o.type ?? 'market') as Order['type']

      const rawTriggerPrice =
        o.stopPrice ??
        (o.info as Record<string, unknown> | undefined)?.['stopPrice'] ??
        (o.info as Record<string, unknown> | undefined)?.['triggerPrice']
      const stopPrice = rawTriggerPrice != null ? parseFloat(String(rawTriggerPrice)) : undefined

      result.push({
        id: o.id,
        contract: marketToContract(market, this.exchangeName),
        side: o.side as 'buy' | 'sell',
        type: orderType,
        qty: o.amount ?? 0,
        price: o.price ?? undefined,
        stopPrice: Number.isFinite(stopPrice) ? stopPrice : undefined,
        reduceOnly: o.reduceOnly ?? false,
        status: mapOrderStatus(o.status),
        filledPrice: o.average ?? undefined,
        filledQty: o.filled ?? undefined,
        filledAt: o.lastTradeTimestamp ? new Date(o.lastTradeTimestamp) : undefined,
        createdAt: new Date(o.timestamp ?? Date.now()),
      })
    }

    const algoOrders = await this.loadBinanceOpenAlgoOrders()
    const seenOrderIds = new Set(result.map((order) => order.id))
    for (const order of algoOrders) {
      if (seenOrderIds.has(order.id)) continue
      result.push(order)
    }

    return result
  }

  private contractIntentKey(contract: Partial<Contract>, kind: 'stop' | 'take_profit'): string | null {
    const base = contract.aliceId ?? contract.symbol
    return base ? `${base}::${kind}` : null
  }

  private readProtectionIntent(
    contract: Partial<Contract>,
    kind: 'stop' | 'take_profit',
  ): { side: 'buy' | 'sell'; triggerPrice: number; qty: number; orderId?: string } | undefined {
    const key = this.contractIntentKey(contract, kind)
    if (!key) return undefined

    const intent = this.protectionIntentCache.get(key)
    if (!intent) return undefined
    if ((Date.now() - intent.updatedAt) > CcxtAccount.PROTECTION_INTENT_TTL_MS) {
      this.protectionIntentCache.delete(key)
      return undefined
    }
    return intent
  }

  private writeProtectionIntent(
    contract: Partial<Contract>,
    kind: 'stop' | 'take_profit',
    intent: { side: 'buy' | 'sell'; triggerPrice: number; qty: number; orderId?: string },
  ): void {
    const key = this.contractIntentKey(contract, kind)
    if (!key) return
    this.protectionIntentCache.set(key, {
      kind,
      ...intent,
      updatedAt: Date.now(),
    })
  }

  private clearProtectionIntent(contract: Partial<Contract>, kind?: 'stop' | 'take_profit'): void {
    if (kind) {
      const key = this.contractIntentKey(contract, kind)
      if (key) this.protectionIntentCache.delete(key)
      return
    }

    for (const candidate of ['stop', 'take_profit'] as const) {
      const key = this.contractIntentKey(contract, candidate)
      if (key) this.protectionIntentCache.delete(key)
    }
  }

  private clearProtectionIntentByOrderId(orderId: string): void {
    for (const [key, intent] of this.protectionIntentCache) {
      if (intent.orderId === orderId) {
        this.protectionIntentCache.delete(key)
      }
    }
  }

  private async loadBinanceOpenAlgoOrders(): Promise<Order[]> {
    if (this.exchange.id !== 'binance') return []

    const ex = this.exchange as Exchange & {
      fapiPrivateGetOpenAlgoOrders?: () => Promise<unknown>
      markets_by_id?: Record<string, { symbol?: string } | Array<{ symbol?: string }>>
    }
    if (typeof ex.fapiPrivateGetOpenAlgoOrders !== 'function') return []

    let raw: unknown
    try {
      raw = await ex.fapiPrivateGetOpenAlgoOrders()
    } catch {
      return []
    }

    if (!Array.isArray(raw)) return []

    const result: Order[] = []

    for (const item of raw) {
      const row = item as Record<string, unknown>
      const algoId = String(row.algoId ?? '')
      const marketId = String(row.symbol ?? '')
      if (!algoId || !marketId) continue

      const marketEntry = ex.markets_by_id?.[marketId]
      const candidateSymbols = Array.isArray(marketEntry)
        ? marketEntry.map((entry) => entry?.symbol).filter((symbol): symbol is string => Boolean(symbol))
        : [marketEntry?.symbol].filter((symbol): symbol is string => Boolean(symbol))

      let market: CcxtMarket | undefined
      let ccxtSymbol: string | undefined
      for (const candidate of candidateSymbols) {
        const found = this.markets[candidate]
        if (found) {
          market = found
          ccxtSymbol = candidate
          break
        }
      }
      if (!market || !ccxtSymbol) continue

      this.orderSymbolCache.set(algoId, ccxtSymbol)

      const orderTypeRaw = String(row.orderType ?? '').toLowerCase()
      const type: Order['type'] = orderTypeRaw.includes('take') && orderTypeRaw.includes('profit')
        ? 'take_profit'
        : orderTypeRaw.includes('stop')
          ? 'stop'
          : 'market'

      const side = String(row.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy'
      const qty = parseFloat(String(row.quantity ?? 0))
      const stopPrice = parseFloat(String(row.triggerPrice ?? 0))
      const limitPrice = parseFloat(String(row.price ?? 0))
      const statusRaw = String(row.algoStatus ?? '').toUpperCase()
      const status: Order['status'] = statusRaw === 'NEW'
        ? 'pending'
        : statusRaw === 'TRIGGERED'
          ? 'filled'
          : statusRaw === 'CANCELED' || statusRaw === 'CANCELLED'
            ? 'cancelled'
            : statusRaw === 'EXPIRED' || statusRaw === 'REJECTED'
              ? 'rejected'
              : 'pending'

      result.push({
        id: algoId,
        contract: marketToContract(market, this.exchangeName),
        side,
        type,
        qty: Number.isFinite(qty) ? qty : 0,
        price: Number.isFinite(limitPrice) && limitPrice > 0 ? limitPrice : undefined,
        stopPrice: Number.isFinite(stopPrice) && stopPrice > 0 ? stopPrice : undefined,
        reduceOnly: Boolean(row.reduceOnly),
        status,
        filledPrice: undefined,
        filledQty: undefined,
        filledAt: undefined,
        createdAt: new Date(Number(row.createTime ?? Date.now())),
      })
    }

    return result
  }

  async getQuote(contract: Contract): Promise<Quote> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) throw new Error('Cannot resolve contract to CCXT symbol')

    const ticker = await this.exchange.fetchTicker(ccxtSymbol)
    const market = this.markets[ccxtSymbol]

    return {
      contract: market
        ? marketToContract(market, this.exchangeName)
        : contract,
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      volume: ticker.baseVolume ?? 0,
      high: ticker.high ?? undefined,
      low: ticker.low ?? undefined,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    }
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['CRYPTO'],
      supportedOrderTypes: ['market', 'limit', 'stop', 'stop_limit', 'take_profit'],
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    return {
      isOpen: true,
      timestamp: new Date(),
    }
  }

  // ---- Provider-specific methods ----

  async getFundingRate(contract: Contract): Promise<FundingRate> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) throw new Error('Cannot resolve contract to CCXT symbol')

    const funding = await this.exchange.fetchFundingRate(ccxtSymbol)
    const market = this.markets[ccxtSymbol]

    return {
      contract: market
        ? marketToContract(market, this.exchangeName)
        : contract,
      fundingRate: funding.fundingRate ?? 0,
      nextFundingTime: funding.fundingDatetime ? new Date(funding.fundingDatetime) : undefined,
      previousFundingRate: funding.previousFundingRate ?? undefined,
      timestamp: new Date(funding.timestamp ?? Date.now()),
    }
  }

  async getOrderBook(contract: Contract, limit?: number): Promise<OrderBook> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) throw new Error('Cannot resolve contract to CCXT symbol')

    const book = await this.exchange.fetchOrderBook(ccxtSymbol, limit)
    const market = this.markets[ccxtSymbol]

    return {
      contract: market
        ? marketToContract(market, this.exchangeName)
        : contract,
      bids: book.bids.map(([p, a]) => [p ?? 0, a ?? 0] as OrderBookLevel),
      asks: book.asks.map(([p, a]) => [p ?? 0, a ?? 0] as OrderBookLevel),
      timestamp: new Date(book.timestamp ?? Date.now()),
    }
  }
}
