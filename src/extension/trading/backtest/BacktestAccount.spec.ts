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

  it('sell stop fills at bar.open when gap down below stopPrice', async () => {
    // Buy first
    const buy = await account.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    replay.step()
    await account.syncPendingOrders([buy.orderId!])

    // Place sell stop at 102 — next bar opens at 104 (above stop), but bar after gaps
    const gapBars: BacktestBar[] = [
      { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 105, low: 99, close: 102, volume: 1000 },
      { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 103, high: 106, low: 101, close: 104, volume: 1000 },
      // Gap down: open at 95, well below stop at 102
      { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 95, high: 97, low: 93, close: 96, volume: 1000 },
    ]
    const gapReplay = makeReplay(gapBars)
    await gapReplay.init()
    const gapAccount = new BacktestAccount({ id: 'gap-test', label: 'Gap', replay: gapReplay, initialCash: 10_000 })

    const b = await gapAccount.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    gapReplay.step()
    await gapAccount.syncPendingOrders([b.orderId!])

    const stop = await gapAccount.placeOrder({ contract, side: 'sell', type: 'stop', qty: 10, stopPrice: 102 })
    gapReplay.step()
    const updates = await gapAccount.syncPendingOrders([stop.orderId!])

    expect(updates).toHaveLength(1)
    // Should fill at bar.open (95) not stopPrice (102) because of gap down
    expect(updates[0].filledPrice).toBe(95)
  })

  it('buy stop fills at bar.open when gap up above stopPrice', async () => {
    const gapBars: BacktestBar[] = [
      { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 105, low: 99, close: 102, volume: 1000 },
      { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 101, high: 103, low: 100, close: 102, volume: 1000 },
      // Gap up: open at 115, well above stop at 105
      { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 115, high: 120, low: 114, close: 118, volume: 1000 },
    ]
    const gapReplay = makeReplay(gapBars)
    await gapReplay.init()
    const gapAccount = new BacktestAccount({ id: 'gap-test', label: 'Gap', replay: gapReplay, initialCash: 10_000 })

    // Skip first bar
    gapReplay.step()

    const stop = await gapAccount.placeOrder({ contract, side: 'buy', type: 'stop', qty: 5, stopPrice: 105 })
    gapReplay.step()
    const updates = await gapAccount.syncPendingOrders([stop.orderId!])

    expect(updates).toHaveLength(1)
    // Should fill at bar.open (115) not stopPrice (105) because of gap up
    expect(updates[0].filledPrice).toBe(115)
  })

  it('stop fills at stopPrice when no gap (normal trigger)', async () => {
    const buy = await account.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    replay.step()
    await account.syncPendingOrders([buy.orderId!])

    // Stop at 99, bar3 low=98 crosses it, open=104 > stopPrice → fill at stopPrice
    const stop = await account.placeOrder({ contract, side: 'sell', type: 'stop', qty: 10, stopPrice: 99 })
    replay.step()
    const updates = await account.syncPendingOrders([stop.orderId!])

    expect(updates).toHaveLength(1)
    expect(updates[0].filledPrice).toBe(99)
  })

  it('applies slippage to market buy orders', async () => {
    const slipReplay = makeReplay(makeBars())
    await slipReplay.init()
    const slipAccount = new BacktestAccount({
      id: 'slip-test', label: 'Slip', replay: slipReplay, initialCash: 10_000, slippageBps: 50, // 0.5%
    })

    const buy = await slipAccount.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    slipReplay.step()
    const updates = await slipAccount.syncPendingOrders([buy.orderId!])

    // Bar2 open=103, slippage buy: 103 * (1 + 50/10000) = 103 * 1.005 = 103.515
    expect(updates).toHaveLength(1)
    expect(updates[0].filledPrice).toBeCloseTo(103.515, 2)
  })

  it('applies slippage to market sell orders (lower fill)', async () => {
    const slipReplay = makeReplay(makeBars())
    await slipReplay.init()
    const slipAccount = new BacktestAccount({
      id: 'slip-test', label: 'Slip', replay: slipReplay, initialCash: 10_000, slippageBps: 50,
    })

    // Buy first
    const buy = await slipAccount.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    slipReplay.step()
    await slipAccount.syncPendingOrders([buy.orderId!])

    // Sell
    const sell = await slipAccount.placeOrder({ contract, side: 'sell', type: 'market', qty: 10 })
    slipReplay.step()
    const updates = await slipAccount.syncPendingOrders([sell.orderId!])

    // Bar3 open=104, slippage sell: 104 * (1 - 50/10000) = 104 * 0.995 = 103.48
    expect(updates).toHaveLength(1)
    expect(updates[0].filledPrice).toBeCloseTo(103.48, 2)
  })

  it('deducts fees from cash on buy and sell', async () => {
    const feeReplay = makeReplay(makeBars())
    await feeReplay.init()
    const feeAccount = new BacktestAccount({
      id: 'fee-test', label: 'Fee', replay: feeReplay, initialCash: 10_000, feeRate: 0.001, // 0.1%
    })

    const buy = await feeAccount.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    feeReplay.step()
    await feeAccount.syncPendingOrders([buy.orderId!])

    // Fill at bar2 open=103, cost=1030, fee=1030*0.001=1.03
    const afterBuy = await feeAccount.getAccount()
    expect(afterBuy.cash).toBeCloseTo(10_000 - 1030 - 1.03, 2)

    // Sell
    const sell = await feeAccount.placeOrder({ contract, side: 'sell', type: 'market', qty: 10 })
    feeReplay.step()
    await feeAccount.syncPendingOrders([sell.orderId!])

    // Fill at bar3 open=104, proceeds=1040, fee=1040*0.001=1.04
    const afterSell = await feeAccount.getAccount()
    // cash = (10000 - 1030 - 1.03) + 1040 - 1.04 = 10007.93
    expect(afterSell.cash).toBeCloseTo(10_007.93, 2)
  })

  // ==================== Short Selling ====================

  it('opens a short position when selling without existing holding', async () => {
    const result = await account.placeOrder({ contract, side: 'sell', type: 'market', qty: 5 })
    expect(result.success).toBe(true)

    replay.step()
    await account.syncPendingOrders([result.orderId!])

    const positions = await account.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].side).toBe('short')
    expect(positions[0].qty).toBe(5)
    expect(positions[0].avgEntryPrice).toBe(103) // bar2 open

    // Cash increases by proceeds: 10000 + 103*5 = 10515
    const info = await account.getAccount()
    expect(info.cash).toBe(10_515)
  })

  it('closes a short position with a buy order', async () => {
    // Open short
    const sell = await account.placeOrder({ contract, side: 'sell', type: 'market', qty: 5 })
    replay.step()
    await account.syncPendingOrders([sell.orderId!])

    // Close short
    const buy = await account.placeOrder({ contract, side: 'buy', type: 'market', qty: 5 })
    replay.step()
    await account.syncPendingOrders([buy.orderId!])

    const positions = await account.getPositions()
    expect(positions).toHaveLength(0)

    // Short entry at 103, close at 104 → loss of 1*5 = 5
    const info = await account.getAccount()
    expect(info.realizedPnL).toBe(-5)
  })

  it('computes unrealizedPnL correctly for short positions', async () => {
    const sell = await account.placeOrder({ contract, side: 'sell', type: 'market', qty: 10 })
    replay.step()
    await account.syncPendingOrders([sell.orderId!])

    // Short at 103, current price is bar2 close=104
    const positions = await account.getPositions()
    expect(positions[0].side).toBe('short')
    // unrealizedPnL = (entry - current) * qty = (103 - 104) * 10 = -10
    expect(positions[0].unrealizedPnL).toBe(-10)
  })

  it('closePosition on a short position places a buy order', async () => {
    const sell = await account.placeOrder({ contract, side: 'sell', type: 'market', qty: 5 })
    replay.step()
    await account.syncPendingOrders([sell.orderId!])

    const closeResult = await account.closePosition(contract)
    expect(closeResult.success).toBe(true)

    replay.step()
    const updates = await account.syncPendingOrders([closeResult.orderId!])
    expect(updates).toHaveLength(1)
    expect(updates[0].currentStatus).toBe('filled')

    const positions = await account.getPositions()
    expect(positions).toHaveLength(0)
  })

  it('short position profit when price drops', async () => {
    // Use bars where price drops
    const dropBars: BacktestBar[] = [
      { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 105, low: 99, close: 102, volume: 1000 },
      { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 95, close: 96, volume: 1000 },
      { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 95, high: 97, low: 90, close: 92, volume: 1000 },
    ]
    const dropReplay = makeReplay(dropBars)
    await dropReplay.init()
    const shortAccount = new BacktestAccount({ id: 'short-test', label: 'Short', replay: dropReplay, initialCash: 10_000 })

    // Open short at bar2 open=100
    const sell = await shortAccount.placeOrder({ contract, side: 'sell', type: 'market', qty: 10 })
    dropReplay.step()
    await shortAccount.syncPendingOrders([sell.orderId!])

    // Close short at bar3 open=95
    const buy = await shortAccount.placeOrder({ contract, side: 'buy', type: 'market', qty: 10 })
    dropReplay.step()
    await shortAccount.syncPendingOrders([buy.orderId!])

    const info = await shortAccount.getAccount()
    // Profit: (100 - 95) * 10 = 50
    expect(info.realizedPnL).toBe(50)
    // Cash: 10000 + 1000 (short proceeds) - 950 (buy cost) = 10050
    expect(info.cash).toBe(10_050)
  })
})
