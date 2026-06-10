import { describe, it, expect, beforeEach } from 'vitest'
import { MetricsCollector } from '../metrics.js'
import { MarketDataError, MarketDataErrorCode } from '../errors.js'

describe('MetricsCollector', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = new MetricsCollector()
  })

  describe('recordSuccess', () => {
    it('increments success count and accumulates latency', () => {
      collector.recordSuccess('yfinance', 100)
      collector.recordSuccess('yfinance', 200)

      const snapshot = collector.snapshot()
      expect(snapshot.successCount).toBe(2)
      expect(snapshot.totalRequests).toBe(2)
      expect(snapshot.avgResponseTimeMs).toBe(150)
    })
  })

  describe('recordError', () => {
    it('increments error count and tracks error codes', () => {
      const error1 = MarketDataError.providerTimeout('yfinance', 5000)
      const error2 = new MarketDataError(
        MarketDataErrorCode.INVALID_SYMBOL,
        'Invalid symbol',
        'yfinance',
        { symbol: 'INVALID' }
      )

      collector.recordError('yfinance', error1, 5000)
      collector.recordError('yfinance', error2, 100)

      const snapshot = collector.snapshot()
      expect(snapshot.errorCount).toBe(2)
      expect(snapshot.errorsByCode[MarketDataErrorCode.PROVIDER_TIMEOUT]).toBe(1)
      expect(snapshot.errorsByCode[MarketDataErrorCode.INVALID_SYMBOL]).toBe(1)
    })
  })

  describe('snapshot', () => {
    it('calculates success rate correctly', () => {
      collector.recordSuccess('yfinance', 100)
      collector.recordSuccess('yfinance', 100)
      collector.recordError('yfinance', MarketDataError.providerTimeout('yfinance', 5000), 5000)

      const snapshot = collector.snapshot()
      expect(snapshot.successRate).toBeCloseTo(0.667, 2)
    })

    it('calculates avg response time correctly', () => {
      collector.recordSuccess('yfinance', 100)
      collector.recordSuccess('yfinance', 200)
      collector.recordSuccess('yfinance', 300)

      const snapshot = collector.snapshot()
      expect(snapshot.avgResponseTimeMs).toBe(200)
    })

    it('marks connection healthy when success rate >= 0.8', () => {
      for (let i = 0; i < 8; i++) {
        collector.recordSuccess('yfinance', 100)
      }
      for (let i = 0; i < 2; i++) {
        collector.recordError('yfinance', MarketDataError.providerTimeout('yfinance', 5000), 5000)
      }

      const snapshot = collector.snapshot()
      expect(snapshot.connectionHealthy).toBe(true)
    })

    it('marks connection unhealthy when success rate < 0.8', () => {
      for (let i = 0; i < 5; i++) {
        collector.recordSuccess('yfinance', 100)
      }
      for (let i = 0; i < 5; i++) {
        collector.recordError('yfinance', MarketDataError.providerTimeout('yfinance', 5000), 5000)
      }

      const snapshot = collector.snapshot()
      expect(snapshot.connectionHealthy).toBe(false)
    })

    it('tracks per-provider health', () => {
      collector.recordSuccess('yfinance', 100)
      collector.recordSuccess('yfinance', 100)
      collector.recordError('yfinance', MarketDataError.providerTimeout('yfinance', 5000), 5000)

      collector.recordSuccess('tradingview', 50)
      collector.recordSuccess('tradingview', 50)
      collector.recordSuccess('tradingview', 50)
      collector.recordSuccess('tradingview', 50)
      collector.recordError('tradingview', MarketDataError.providerTimeout('tradingview', 5000), 5000)

      const snapshot = collector.snapshot()
      expect(snapshot.providerHealth.yfinance.successRate).toBeCloseTo(0.667, 2)
      expect(snapshot.providerHealth.yfinance.healthy).toBe(false)
      expect(snapshot.providerHealth.tradingview.successRate).toBe(0.8)
      expect(snapshot.providerHealth.tradingview.healthy).toBe(true)
      expect(snapshot.providerHealth.tradingview.avgLatencyMs).toBe(1040)
    })

    it('returns zero metrics when no data', () => {
      const snapshot = collector.snapshot()
      expect(snapshot.successRate).toBe(0)
      expect(snapshot.avgResponseTimeMs).toBe(0)
      expect(snapshot.totalRequests).toBe(0)
    })
  })

  describe('reset', () => {
    it('clears all metrics', () => {
      collector.recordSuccess('yfinance', 100)
      collector.recordError('yfinance', MarketDataError.providerTimeout('yfinance', 5000), 5000)

      collector.reset()

      const snapshot = collector.snapshot()
      expect(snapshot.totalRequests).toBe(0)
      expect(snapshot.successCount).toBe(0)
      expect(snapshot.errorCount).toBe(0)
      expect(Object.keys(snapshot.errorsByCode)).toHaveLength(0)
      expect(Object.keys(snapshot.providerHealth)).toHaveLength(0)
    })
  })
})
