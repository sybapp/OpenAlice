import type { Contract, ContractDescription, ContractDetails } from '../contract.js'
import type {
  AccountCapabilities,
  AccountInfo,
  ITradingAccount,
  MarketClock,
  Order,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
} from '../interfaces.js'
import type { OrderStatusUpdate } from '../git/types.js'
import type { BacktestAccountOptions, BacktestHolding } from './types.js'

export class BacktestAccount implements ITradingAccount {
  readonly id: string
  readonly provider = 'backtest'
  readonly label: string

  private cash: number
  private realizedPnL = 0
  private holdings = new Map<string, BacktestHolding>()
  private orders: Order[] = []
  private nextOrderId = 1

  constructor(private readonly options: BacktestAccountOptions) {
    this.id = options.id
    this.label = options.label
    this.cash = options.initialCash
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    return [{ contract: { symbol: pattern.toUpperCase(), secType: 'STK', currency: 'USD', exchange: 'BACKTEST' } }]
  }

  async getContractDetails(query: Partial<Contract>): Promise<ContractDetails | null> {
    return {
      contract: { ...query, secType: query.secType ?? 'STK', exchange: query.exchange ?? 'BACKTEST', currency: query.currency ?? 'USD' },
      longName: query.symbol ?? query.aliceId ?? 'Backtest Contract',
    }
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!['market', 'limit', 'stop'].includes(order.type)) {
      return { success: false, error: `Unsupported order type: ${order.type}` }
    }

    const contract = this.normalizeContract(order.contract)
    const orderId = this.createOrderId()
    const record: Order = {
      id: orderId,
      contract,
      side: order.side,
      type: order.type,
      qty: order.qty ?? 0,
      price: order.price,
      stopPrice: order.stopPrice,
      reduceOnly: order.reduceOnly,
      timeInForce: order.timeInForce,
      goodTillDate: order.goodTillDate,
      extendedHours: order.extendedHours,
      parentId: order.parentId,
      ocaGroup: order.ocaGroup,
      status: 'pending',
      createdAt: this.options.replay.getCurrentTime(),
    }

    this.orders.push(record)
    return { success: true, orderId }
  }

  async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<OrderResult> {
    const order = this.orders.find((item) => item.id === orderId)
    if (!order) return { success: false, error: 'Order not found' }
    if (order.status !== 'pending') return { success: false, error: 'Only pending orders can be modified' }

    if (changes.qty != null) order.qty = changes.qty
    if (changes.price != null) order.price = changes.price
    if (changes.stopPrice != null) order.stopPrice = changes.stopPrice
    if (changes.type) order.type = changes.type
    if (changes.timeInForce) order.timeInForce = changes.timeInForce
    if (changes.goodTillDate) order.goodTillDate = changes.goodTillDate

    return { success: true, orderId }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const order = this.orders.find((item) => item.id === orderId)
    if (!order || order.status !== 'pending') return false
    order.status = 'cancelled'
    return true
  }

  async closePosition(contract: Contract, qty?: number): Promise<OrderResult> {
    const normalized = this.normalizeContract(contract)
    const holding = this.holdings.get(this.contractKey(normalized))
    if (!holding) return { success: false, error: 'Position not found' }
    return this.placeOrder({
      contract: normalized,
      side: 'sell',
      type: 'market',
      qty: qty ?? holding.qty,
    })
  }

  async getAccount(): Promise<AccountInfo> {
    const positions = await this.getPositions()
    const unrealizedPnL = positions.reduce((sum, position) => sum + position.unrealizedPnL, 0)
    const marketValue = positions.reduce((sum, position) => sum + position.marketValue, 0)
    return {
      cash: this.cash,
      equity: this.cash + marketValue,
      unrealizedPnL,
      realizedPnL: this.realizedPnL,
      portfolioValue: this.cash + marketValue,
      buyingPower: this.cash,
    }
  }

  async getPositions(): Promise<Position[]> {
    const positions: Position[] = []
    for (const holding of this.holdings.values()) {
      const quote = await this.getQuote(holding.contract)
      const marketValue = quote.last * holding.qty
      const unrealizedPnL = (quote.last - holding.avgEntryPrice) * holding.qty
      positions.push({
        contract: holding.contract,
        side: 'long',
        qty: holding.qty,
        avgEntryPrice: holding.avgEntryPrice,
        currentPrice: quote.last,
        marketValue,
        unrealizedPnL,
        unrealizedPnLPercent: holding.avgEntryPrice > 0 ? (unrealizedPnL / (holding.avgEntryPrice * holding.qty)) * 100 : 0,
        costBasis: holding.avgEntryPrice * holding.qty,
        leverage: 1,
      })
    }
    return positions
  }

  async getOrders(): Promise<Order[]> {
    return this.orders.map((order) => ({ ...order }))
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const symbol = contract.symbol ?? contract.aliceId
    if (!symbol) throw new Error('Missing contract symbol')
    const resolvedSymbol = contract.symbol ?? this.parseSymbolFromAliceId(symbol)
    if (!resolvedSymbol) throw new Error('Missing contract symbol')
    return this.options.replay.getCurrentQuote(resolvedSymbol)
  }

  async getMarketClock(): Promise<MarketClock> {
    return {
      isOpen: true,
      timestamp: this.options.replay.getCurrentTime(),
    }
  }

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['STK', 'CRYPTO', 'CASH'],
      supportedOrderTypes: ['market', 'limit', 'stop'],
    }
  }

  async syncPendingOrders(orderIds?: string[]): Promise<OrderStatusUpdate[]> {
    const currentTime = this.options.replay.getCurrentTime()
    const updates: OrderStatusUpdate[] = []

    for (const order of this.orders) {
      if (order.status !== 'pending') continue
      if (orderIds && !orderIds.includes(order.id)) continue
      if (order.createdAt.getTime() >= currentTime.getTime()) continue

      const fill = this.resolveFillForCurrentBar(order)
      if (!fill) continue

      const holding = order.side === 'sell'
        ? this.holdings.get(this.contractKey(order.contract))
        : undefined
      const realizedPnLDelta = holding
        ? (fill.price - holding.avgEntryPrice) * order.qty
        : undefined

      this.applyFill(order, fill.price, currentTime)
      updates.push({
        orderId: order.id,
        symbol: order.contract.symbol ?? this.parseSymbolFromAliceId(order.contract.aliceId) ?? 'unknown',
        previousStatus: 'pending',
        currentStatus: 'filled',
        filledPrice: fill.price,
        filledQty: order.filledQty,
        realizedPnLDelta,
      })
    }

    return updates
  }

  private resolveFillForCurrentBar(order: Order): { price: number } | null {
    const symbol = order.contract.symbol ?? this.parseSymbolFromAliceId(order.contract.aliceId)
    if (!symbol) return null

    const bar = this.options.replay.getCurrentBars().find((entry) => entry.symbol === symbol)
    if (!bar) return null

    if (order.type === 'market') {
      return { price: bar.open }
    }

    if (order.type === 'limit') {
      if (order.side === 'buy' && order.price != null && bar.low <= order.price) {
        return { price: order.price }
      }
      if (order.side === 'sell' && order.price != null && bar.high >= order.price) {
        return { price: order.price }
      }
    }

    if (order.type === 'stop') {
      if (order.side === 'buy' && order.stopPrice != null && bar.high >= order.stopPrice) {
        return { price: order.stopPrice }
      }
      if (order.side === 'sell' && order.stopPrice != null && bar.low <= order.stopPrice) {
        return { price: order.stopPrice }
      }
    }

    return null
  }

  private applyFill(order: Order, price: number, ts: Date): void {
    order.status = 'filled'
    order.filledPrice = price
    order.filledQty = order.qty
    order.filledAt = ts

    const key = this.contractKey(order.contract)
    const holding = this.holdings.get(key)

    if (order.side === 'buy') {
      const currentQty = holding?.qty ?? 0
      const currentCost = (holding?.avgEntryPrice ?? 0) * currentQty
      const fillCost = price * order.qty
      const newQty = currentQty + order.qty
      this.cash -= fillCost
      this.holdings.set(key, {
        contract: order.contract,
        qty: newQty,
        avgEntryPrice: newQty > 0 ? (currentCost + fillCost) / newQty : price,
      })
      return
    }

    const sellQty = order.qty
    if (!holding || holding.qty < sellQty) {
      throw new Error('Cannot sell more than current position size in backtest account')
    }

    this.cash += price * sellQty
    this.realizedPnL += (price - holding.avgEntryPrice) * sellQty

    const remainingQty = holding.qty - sellQty
    if (remainingQty <= 0) {
      this.holdings.delete(key)
    } else {
      this.holdings.set(key, {
        ...holding,
        qty: remainingQty,
      })
    }
  }

  private normalizeContract(contract: Contract): Contract {
    const symbol = contract.symbol ?? this.parseSymbolFromAliceId(contract.aliceId)
    return {
      ...contract,
      symbol,
      aliceId: contract.aliceId ?? (symbol ? `backtest-${symbol}` : undefined),
      secType: contract.secType ?? 'STK',
      exchange: contract.exchange ?? 'BACKTEST',
      currency: contract.currency ?? 'USD',
    }
  }

  private contractKey(contract: Contract): string {
    return contract.aliceId ?? contract.symbol ?? 'unknown'
  }

  private createOrderId(): string {
    const orderId = `bt-order-${this.nextOrderId}`
    this.nextOrderId += 1
    return orderId
  }

  private parseSymbolFromAliceId(aliceId?: string): string | undefined {
    if (!aliceId) return undefined
    const index = aliceId.indexOf('-')
    return index >= 0 ? aliceId.slice(index + 1) : aliceId
  }
}
