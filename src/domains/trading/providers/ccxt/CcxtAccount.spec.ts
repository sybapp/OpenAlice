import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  createOrderCalls: [] as Array<{
    symbol: string
    type: string
    side: string
    amount: number
    price: number | undefined
    params: Record<string, unknown>
  }>,
}))

vi.mock('ccxt', () => {
  class MockExchange {
    markets = {
      'BTC/USDT:USDT': {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        base: 'BTC',
        quote: 'USDT',
        type: 'swap',
        linear: true,
        inverse: false,
        precision: { price: 0.1, amount: 0.001 },
      },
    }

    options: Record<string, unknown>

    constructor(opts: Record<string, unknown>) {
      this.options = (opts.options ?? {}) as Record<string, unknown>
    }

    setSandboxMode() {}

    enableDemoTrading() {}

    async fetchMarkets() {
      return Object.values(this.markets)
    }

    async loadMarkets() {
      return this.markets
    }

    async fetchTicker() {
      return { last: 100 }
    }

    async createOrder(
      symbol: string,
      type: string,
      side: string,
      amount: number,
      price: number | undefined,
      params: Record<string, unknown>,
    ) {
      mockState.createOrderCalls.push({ symbol, type, side, amount, price, params })
      return {
        id: `order-${mockState.createOrderCalls.length}`,
        status: 'open',
        average: undefined,
        price,
        filled: 0,
      }
    }
  }

  return { default: { binance: MockExchange } }
})

import { CcxtAccount } from './CcxtAccount.js'

describe('CcxtAccount placeOrder', () => {
  beforeEach(() => {
    mockState.createOrderCalls.length = 0
  })

  it('uses a neutral default label that does not reveal sandbox mode', () => {
    const account = new CcxtAccount({
      exchange: 'binance',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
      demoTrading: true,
      defaultMarketType: 'swap',
    })

    expect(account.label).toBe('Binance')
  })

  it('passes stopPrice and triggerPrice for stop orders', async () => {
    const account = new CcxtAccount({
      exchange: 'binance',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
      demoTrading: true,
      defaultMarketType: 'swap',
    })
    await account.init()

    const result = await account.placeOrder({
      contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTC/USDT:USDT' },
      side: 'buy',
      type: 'stop',
      qty: 0.1,
      stopPrice: 101,
    })

    expect(result.success).toBe(true)
    expect(mockState.createOrderCalls).toHaveLength(1)
    expect(mockState.createOrderCalls[0]).toMatchObject({
      symbol: 'BTC/USDT:USDT',
      type: 'stop',
      side: 'buy',
      amount: 0.1,
      price: undefined,
      params: { stopPrice: 101, triggerPrice: 101 },
    })
  })

  it('passes both limit price and stopPrice for stop_limit orders', async () => {
    const account = new CcxtAccount({
      exchange: 'binance',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
      demoTrading: true,
      defaultMarketType: 'swap',
    })
    await account.init()

    const result = await account.placeOrder({
      contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTC/USDT:USDT' },
      side: 'sell',
      type: 'stop_limit',
      qty: 0.2,
      price: 99,
      stopPrice: 100,
      reduceOnly: true,
    })

    expect(result.success).toBe(true)
    expect(mockState.createOrderCalls[0]).toMatchObject({
      type: 'stop_limit',
      side: 'sell',
      amount: 0.2,
      price: 99,
      params: { reduceOnly: true, stopPrice: 100, triggerPrice: 100 },
    })
  })

  it('rejects stop orders without stopPrice', async () => {
    const account = new CcxtAccount({
      exchange: 'binance',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
      demoTrading: true,
      defaultMarketType: 'swap',
    })
    await account.init()

    const result = await account.placeOrder({
      contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTC/USDT:USDT' },
      side: 'buy',
      type: 'stop',
      qty: 0.1,
    })

    expect(result).toEqual({ success: false, error: 'Order type stop requires stopPrice' })
    expect(mockState.createOrderCalls).toHaveLength(0)
  })
})
