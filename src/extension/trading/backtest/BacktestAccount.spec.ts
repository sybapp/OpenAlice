import { describe, it, expect, beforeEach } from 'vitest'
import { BacktestAccount } from './BacktestAccount.js'
import { HistoricalMarketReplay } from './HistoricalMarketReplay.js'
import type { BacktestBar } from './types.js'
import type { Contract } from '../contract.js'

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    aliceId: 'backtest-AAPL',
    symbol: 'AAPL',
    secType: 'STK',
    exchange: 'NASDAQ',
    currency: 'USD',
    ...overrides,
  }
}

function makeReplay(bars: BacktestBar[]) {
  return new HistoricalMarketReplay({ bars })
}

function makeBars(): BacktestBar[] {
  return [
    { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 105, low: 99, close: 102, volume: 1_000 },
    { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 103, high: 106, low: 101, close: 104, volume: 1_000 },
    { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 104, high: 110, low: 98, close: 109, volume: 1_000 },
  ]
}

describe('BacktestAccount', () => {
  let replay: HistoricalMarketReplay
  let account: BacktestAccount
  const contract = makeContract()

  beforeEach(async () => {
    replay = makeReplay(makeBars())
    await replay.init()
    account = new BacktestAccount({
      id: 'backtest-paper',
      label: 'Backtest Paper',
      replay,
      initialCash: 10_000,
    })
    await account.init()
  })

  it('keeps market orders pending until the next bar sync and fills at next-bar open', async () => {
    const result = await account.placeOrder({
      contract,
      side: 'buy',
      type: 'market',
      qty: 10,
    })

    expect(result.success).toBe(true)
    expect(result.filledPrice).toBeUndefined()
    expect(result.filledQty).toBeUndefined()

    let orders = await account.getOrders()
    expect(orders[0].status).toBe('pending')

    let info = await account.getAccount()
    expect(info.cash).toBe(10_000)
    expect(info.equity).toBe(10_000)

    const sameBarUpdates = await account.syncPendingOrders([result.orderId!])
    expect(sameBarUpdates).toEqual([])

    replay.step()
    const updates = await account.syncPendingOrders([result.orderId!])
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      orderId: result.orderId,
      previousStatus: 'pending',
      currentStatus: 'filled',
      filledPrice: 103,
      filledQty: 10,
    })

    orders = await account.getOrders()
    expect(orders[0].status).toBe('filled')
    expect(orders[0].filledPrice).toBe(103)

    const positions = await account.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].qty).toBe(10)
    expect(positions[0].avgEntryPrice).toBe(103)

    info = await account.getAccount()
    expect(info.cash).toBe(8_970)
    expect(info.unrealizedPnL).toBe(10)
    expect(info.equity).toBe(10_010)
  })

  it('fills limit buy only during a later sync when the current bar crosses the price', async () => {
    const result = await account.placeOrder({
      contract,
      side: 'buy',
      type: 'limit',
      qty: 10,
      price: 102,
    })

    expect(result.success).toBe(true)
    expect((await account.getOrders())[0].status).toBe('pending')

    replay.step()
    const updates = await account.syncPendingOrders([result.orderId!])
    expect(updates).toHaveLength(1)
    expect(updates[0].filledPrice).toBe(102)

    const orders = await account.getOrders()
    expect(orders[0].status).toBe('filled')
    expect(orders[0].filledPrice).toBe(102)
  })

  it('keeps limit order pending when no later bar crosses the price', async () => {
    const result = await account.placeOrder({
      contract,
      side: 'buy',
      type: 'limit',
      qty: 10,
      price: 97,
    })

    expect(result.success).toBe(true)

    replay.step()
    expect(await account.syncPendingOrders([result.orderId!])).toEqual([])
    replay.step()
    expect(await account.syncPendingOrders([result.orderId!])).toEqual([])

    const orders = await account.getOrders()
    expect(orders).toHaveLength(1)
    expect(orders[0].status).toBe('pending')
  })

  it('triggers stop sell on a later sync when the current bar low crosses the stop price', async () => {
    const buy = await account.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    replay.step()
    await account.syncPendingOrders([buy.orderId!])

    const result = await account.placeOrder({
      contract,
      side: 'sell',
      type: 'stop',
      qty: 10,
      stopPrice: 99,
    })

    expect(result.success).toBe(true)
    expect((await account.getOrders()).find((order) => order.id === result.orderId)?.status).toBe('pending')

    replay.step()
    const updates = await account.syncPendingOrders([result.orderId!])
    expect(updates).toHaveLength(1)
    expect(updates[0].filledQty).toBe(10)
    expect(updates[0].filledPrice).toBe(99)
    expect(updates[0].realizedPnLDelta).toBe(-40)
  })

  it('supports modifying and cancelling orders while they are still pending', async () => {
    const placed = await account.placeOrder({
      contract,
      side: 'buy',
      type: 'limit',
      qty: 10,
      price: 97,
    })

    expect(placed.orderId).toBeDefined()

    const modified = await account.modifyOrder(placed.orderId!, { price: 102 })
    expect(modified.success).toBe(true)

    const cancelled = await account.cancelOrder(placed.orderId!)
    expect(cancelled).toBe(true)

    replay.step()
    expect(await account.syncPendingOrders([placed.orderId!])).toEqual([])

    const orders = await account.getOrders()
    expect(orders[0].price).toBe(102)
    expect(orders[0].status).toBe('cancelled')
  })

  it('updates cash and equity only after sync fill happens', async () => {
    const result = await account.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })

    const beforeFill = await account.getAccount()
    expect(beforeFill.cash).toBe(10_000)
    expect(beforeFill.equity).toBe(10_000)
    expect(beforeFill.unrealizedPnL).toBe(0)

    replay.step()
    await account.syncPendingOrders([result.orderId!])

    const afterFill = await account.getAccount()
    expect(afterFill.cash).toBe(8_970)
    expect(afterFill.unrealizedPnL).toBe(10)
    expect(afterFill.equity).toBe(10_010)
  })

  it('rejects unsupported order types explicitly', async () => {
    const result = await account.placeOrder({
      contract,
      side: 'buy',
      type: 'trailing_stop',
      qty: 10,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unsupported order type')
  })
})
