import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createOperationDispatcher } from './operation-dispatcher.js'
import { MockTradingAccount, makeOrder, makeOrderResult, makePosition } from './__test__/mock-account.js'
import type { Operation } from './git/types.js'

describe('createOperationDispatcher', () => {
  let account: MockTradingAccount
  let dispatch: (op: Operation) => Promise<unknown>

  beforeEach(() => {
    account = new MockTradingAccount()
    dispatch = createOperationDispatcher(account)
  })

  // ==================== placeOrder ====================

  describe('placeOrder', () => {
    it('calls account.placeOrder with constructed contract and order params', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: {
          symbol: 'AAPL',
          side: 'buy',
          type: 'market',
          qty: 10,
          timeInForce: 'day',
        },
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.placeOrder).toHaveBeenCalledTimes(1)
      const call = account.placeOrder.mock.calls[0][0]
      expect(call.contract.symbol).toBe('AAPL')
      expect(call.side).toBe('buy')
      expect(call.type).toBe('market')
      expect(call.qty).toBe(10)
      expect(result.success).toBe(true)
    })

    it('passes aliceId and extra contract fields', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: {
          aliceId: 'alpaca-AAPL',
          symbol: 'AAPL',
          secType: 'STK',
          currency: 'USD',
          exchange: 'NASDAQ',
          side: 'buy',
          type: 'limit',
          qty: 5,
          price: 150,
        },
      }

      await dispatch(op)

      const call = account.placeOrder.mock.calls[0][0]
      expect(call.contract.aliceId).toBe('alpaca-AAPL')
      expect(call.contract.secType).toBe('STK')
      expect(call.contract.currency).toBe('USD')
      expect(call.contract.exchange).toBe('NASDAQ')
      expect(call.price).toBe(150)
    })

    it('returns order info on success with filled status', async () => {
      account.placeOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-123',
        filledPrice: 155,
        filledQty: 10,
      }))

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      const order = result.order as Record<string, unknown>
      expect(order.id).toBe('ord-123')
      expect(order.status).toBe('filled')
      expect(order.filledPrice).toBe(155)
    })

    it('returns pending status when no filledPrice', async () => {
      account.placeOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-456',
        filledPrice: undefined,
        filledQty: undefined,
      }))

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, price: 140 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      const order = result.order as Record<string, unknown>
      expect(order.status).toBe('pending')
    })

    it('returns error on failure', async () => {
      account.placeOrder.mockResolvedValue({ success: false, error: 'Insufficient funds' })

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toBe('Insufficient funds')
      expect(result.order).toBeUndefined()
    })

    it('does not duplicate identical protection orders when broker order list is temporarily empty', async () => {
      account.placeOrder
        .mockResolvedValueOnce(makeOrderResult({ orderId: 'sl-1', filledPrice: undefined, filledQty: undefined }))
        .mockResolvedValue(makeOrderResult({ orderId: 'sl-2', filledPrice: undefined, filledQty: undefined }))

      const op: Operation = {
        action: 'placeOrder',
        params: {
          aliceId: 'binance-BTCUSDT',
          symbol: 'BTCUSDT',
          side: 'sell',
          type: 'stop',
          qty: 0.5,
          stopPrice: 88000,
          reduceOnly: true,
        },
      }

      const first = await dispatch(op) as Record<string, unknown>
      const second = await dispatch(op) as Record<string, unknown>

      expect(account.placeOrder).toHaveBeenCalledTimes(1)
      expect(first.success).toBe(true)
      expect(second.success).toBe(true)
      expect((second.order as Record<string, unknown>).id).toBe('sl-1')
    })

    it('arms protection immediately for filled entries', async () => {
      account.setPositions([
        makePosition({
          contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
          qty: 0.5,
          avgEntryPrice: 90000,
          currentPrice: 90000,
          marketValue: 45000,
          costBasis: 45000,
        }),
      ])

      account.placeOrder
        .mockResolvedValueOnce(makeOrderResult({ orderId: 'entry-1', filledPrice: 90000, filledQty: 0.5 }))
        .mockResolvedValue(makeOrderResult({ orderId: 'prot-1', filledPrice: undefined, filledQty: undefined }))

      const op: Operation = {
        action: 'placeOrder',
        params: {
          aliceId: 'binance-BTCUSDT',
          symbol: 'BTCUSDT',
          side: 'buy',
          type: 'market',
          qty: 0.5,
          protection: { stopLossPct: 0.8, takeProfitPct: 1.2, takeProfitSizeRatio: 0.5 },
        },
      }

      await dispatch(op)

      await vi.waitFor(() => {
        expect(account.placeOrder).toHaveBeenCalledTimes(3)
      })

      expect(account.placeOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({
        side: 'sell',
        type: 'stop',
        qty: 0.5,
        stopPrice: 89280,
        reduceOnly: true,
      }))
      expect(account.placeOrder).toHaveBeenNthCalledWith(3, expect.objectContaining({
        side: 'sell',
        type: 'take_profit',
        qty: 0.25,
        stopPrice: 91080,
        reduceOnly: true,
      }))
    })

    it('arms protection after a pending limit order fills', async () => {
      vi.useFakeTimers()
      try {
        account.setPositions([
          makePosition({
            contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
            qty: 0.5,
            avgEntryPrice: 90000,
            currentPrice: 90000,
            marketValue: 45000,
            costBasis: 45000,
          }),
        ])

        account.placeOrder
          .mockResolvedValueOnce(makeOrderResult({ orderId: 'entry-2', filledPrice: undefined, filledQty: undefined }))
          .mockResolvedValue(makeOrderResult({ orderId: 'prot-2', filledPrice: undefined, filledQty: undefined }))

        let getOrdersCall = 0
        account.getOrders.mockImplementation(async () => {
          getOrdersCall += 1
          if (getOrdersCall === 1) {
            return [makeOrder({
              id: 'entry-2',
              contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
              side: 'buy',
              type: 'limit',
              qty: 0.5,
              price: 90000,
              status: 'pending',
            })]
          }
          if (getOrdersCall === 2) {
            return [makeOrder({
              id: 'entry-2',
              contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
              side: 'buy',
              type: 'limit',
              qty: 0.5,
              price: 90000,
              stopPrice: undefined,
              status: 'filled',
              filledPrice: 90000,
              filledQty: 0.5,
            })]
          }
          return []
        })

        const op: Operation = {
          action: 'placeOrder',
          params: {
            aliceId: 'binance-BTCUSDT',
            symbol: 'BTCUSDT',
            side: 'buy',
            type: 'limit',
            qty: 0.5,
            price: 90000,
            protection: { stopLossPct: 0.8, takeProfitPct: 1.2 },
          },
        }

        await dispatch(op)
        expect(account.placeOrder).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(3500)

        expect(account.placeOrder).toHaveBeenCalledTimes(3)
        expect(account.placeOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({
          type: 'stop',
          stopPrice: 89280,
          reduceOnly: true,
        }))
        expect(account.placeOrder).toHaveBeenNthCalledWith(3, expect.objectContaining({
          type: 'take_profit',
          stopPrice: 91080,
          reduceOnly: true,
        }))
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ==================== closePosition ====================

  describe('closePosition', () => {
    it('calls account.closePosition with contract and optional qty', async () => {
      const op: Operation = {
        action: 'closePosition',
        params: { symbol: 'AAPL', qty: 5 },
      }

      await dispatch(op)

      expect(account.closePosition).toHaveBeenCalledTimes(1)
      const [contract, qty] = account.closePosition.mock.calls[0]
      expect(contract.symbol).toBe('AAPL')
      expect(qty).toBe(5)
    })

    it('passes undefined qty for full close', async () => {
      const op: Operation = {
        action: 'closePosition',
        params: { symbol: 'AAPL' },
      }

      await dispatch(op)

      const [, qty] = account.closePosition.mock.calls[0]
      expect(qty).toBeUndefined()
    })
  })

  // ==================== cancelOrder ====================

  describe('cancelOrder', () => {
    it('calls account.cancelOrder and returns success', async () => {
      const op: Operation = {
        action: 'cancelOrder',
        params: { orderId: 'ord-789' },
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.cancelOrder).toHaveBeenCalledWith('ord-789')
      expect(result.success).toBe(true)
    })

    it('returns error message on cancel failure', async () => {
      account.cancelOrder.mockResolvedValue(false)

      const op: Operation = {
        action: 'cancelOrder',
        params: { orderId: 'ord-789' },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toContain('Failed to cancel')
    })
  })

  // ==================== modifyOrder ====================

  describe('modifyOrder', () => {
    it('calls account.modifyOrder with orderId and changes', async () => {
      const op: Operation = {
        action: 'modifyOrder',
        params: { orderId: 'ord-123', price: 155, qty: 20 },
      }

      const result = await dispatch(op) as Record<string, unknown>

      expect(account.modifyOrder).toHaveBeenCalledTimes(1)
      const [orderId, changes] = account.modifyOrder.mock.calls[0]
      expect(orderId).toBe('ord-123')
      expect(changes.price).toBe(155)
      expect(changes.qty).toBe(20)
      expect(result.success).toBe(true)
    })

    it('returns order info on success', async () => {
      account.modifyOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-123',
        filledPrice: undefined,
        filledQty: undefined,
      }))

      const op: Operation = {
        action: 'modifyOrder',
        params: { orderId: 'ord-123', price: 160 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      const order = result.order as Record<string, unknown>
      expect(order.id).toBe('ord-123')
      expect(order.status).toBe('pending')
    })

    it('returns error on failure', async () => {
      account.modifyOrder.mockResolvedValue({ success: false, error: 'Order not found' })

      const op: Operation = {
        action: 'modifyOrder',
        params: { orderId: 'ord-999', price: 100 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(result.error).toBe('Order not found')
      expect(result.order).toBeUndefined()
    })
  })

  // ==================== unknown action ====================

  describe('unknown action', () => {
    it('throws for unknown operation action', async () => {
      const op: Operation = {
        action: 'syncOrders' as never,
        params: {},
      }

      await expect(dispatch(op)).rejects.toThrow('Unknown operation action')
    })
  })

  // ==================== partial fill ====================

  describe('partial fill', () => {
    it('returns partially_filled status when filledQty < requested qty', async () => {
      account.placeOrder.mockResolvedValue(makeOrderResult({
        orderId: 'ord-partial',
        filledPrice: 150,
        filledQty: 3,
      }))

      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      }

      const result = await dispatch(op) as Record<string, unknown>
      expect(result.success).toBe(true)
      const order = result.order as Record<string, unknown>
      expect(order.status).toBe('partially_filled')
      expect(order.filledQty).toBe(3)
    })

    it('uses filledQty for protection order qty on partial fill', async () => {
      account.setPositions([
        makePosition({
          contract: { aliceId: 'binance-BTCUSDT', symbol: 'BTCUSDT', secType: 'CRYPTO' },
          qty: 0.3,
          avgEntryPrice: 90000,
          currentPrice: 90000,
          marketValue: 27000,
          costBasis: 27000,
        }),
      ])

      account.placeOrder
        .mockResolvedValueOnce(makeOrderResult({ orderId: 'entry-partial', filledPrice: 90000, filledQty: 0.3 }))
        .mockResolvedValue(makeOrderResult({ orderId: 'prot-partial', filledPrice: undefined, filledQty: undefined }))

      const op: Operation = {
        action: 'placeOrder',
        params: {
          aliceId: 'binance-BTCUSDT',
          symbol: 'BTCUSDT',
          side: 'buy',
          type: 'market',
          qty: 0.5,
          protection: { stopLossPct: 1 },
        },
      }

      await dispatch(op)

      await vi.waitFor(() => {
        expect(account.placeOrder).toHaveBeenCalledTimes(2)
      })

      // Protection order should use filledQty (0.3), not position.qty or request.qty
      expect(account.placeOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({
        type: 'stop',
        qty: 0.3,
        reduceOnly: true,
      }))
    })
  })

  // ==================== concurrent protection ====================

  describe('concurrent protection upsert', () => {
    it('serializes concurrent upsert calls — only one placeOrder per key', async () => {
      account.setPositions([
        makePosition({
          contract: { aliceId: 'binance-ETHUSDT', symbol: 'ETHUSDT', secType: 'CRYPTO' },
          qty: 1,
          avgEntryPrice: 3000,
          currentPrice: 3000,
          marketValue: 3000,
          costBasis: 3000,
        }),
      ])

      // First call places the order, second should see the intent and skip
      account.placeOrder
        .mockResolvedValueOnce(makeOrderResult({ orderId: 'entry-1', filledPrice: 3000, filledQty: 1 }))
        .mockResolvedValue(makeOrderResult({ orderId: 'prot-1', filledPrice: undefined, filledQty: undefined }))

      const op: Operation = {
        action: 'placeOrder',
        params: {
          aliceId: 'binance-ETHUSDT',
          symbol: 'ETHUSDT',
          side: 'buy',
          type: 'market',
          qty: 1,
          protection: { stopLossPct: 2 },
        },
      }

      // Fire two dispatches concurrently
      await Promise.all([dispatch(op), dispatch(op)])

      await vi.waitFor(() => {
        // entry order + one stop loss = 2 calls (not 3 — second stop should be deduped)
        expect(account.placeOrder.mock.calls.length).toBeGreaterThanOrEqual(2)
      })

      // Count stop-loss placeOrder calls
      const stopCalls = account.placeOrder.mock.calls.filter(
        (call) => call[0].type === 'stop' && call[0].reduceOnly === true,
      )
      expect(stopCalls.length).toBe(1)
    })
  })
})
