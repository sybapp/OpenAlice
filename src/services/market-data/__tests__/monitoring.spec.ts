import { describe, it, expect, beforeEach } from 'vitest'
import { MarketDataMonitor } from '../monitoring.js'
import { MarketDataError, MarketDataErrorCode } from '../errors.js'

describe('MarketDataMonitor', () => {
  let monitor: MarketDataMonitor

  beforeEach(() => {
    monitor = new MarketDataMonitor()
  })

  describe('trackRequest', () => {
    it('increments request count', () => {
      const endTimer = monitor.trackRequest('/equity/price/quote', 'yfinance')
      endTimer()

      const metrics = monitor.getMetrics('/equity/price/quote', 'yfinance')
      expect(metrics.size).toBe(1)
      expect(metrics.get('yfinance:/equity/price/quote')?.requestCount).toBe(1)
    })

    it('returns latency calculator', () => {
      const endTimer = monitor.trackRequest('/equity/price/quote', 'yfinance')
      const latencyMs = endTimer()

      expect(latencyMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('trackSuccess', () => {
    it('accumulates latency', () => {
      monitor.trackRequest('/equity/price/quote', 'yfinance')
      monitor.trackSuccess('/equity/price/quote', 'yfinance', 100)
      monitor.trackSuccess('/equity/price/quote', 'yfinance', 200)

      const metrics = monitor.getMetrics('/equity/price/quote', 'yfinance')
      expect(metrics.get('yfinance:/equity/price/quote')?.totalLatencyMs).toBe(300)
    })
  })

  describe('trackError', () => {
    it('increments error count and stores error', () => {
      const error = MarketDataError.providerTimeout('yfinance', 5000)
      monitor.trackError('/equity/price/quote', 'yfinance', error, 5000)

      const metrics = monitor.getMetrics('/equity/price/quote', 'yfinance')
      const endpointMetrics = metrics.get('yfinance:/equity/price/quote')
      expect(endpointMetrics?.errorCount).toBe(1)
      expect(endpointMetrics?.errors).toHaveLength(1)
      expect(endpointMetrics?.errors[0].code).toBe(MarketDataErrorCode.PROVIDER_TIMEOUT)
    })

    it('caps error history at 100', () => {
      const error = MarketDataError.providerTimeout('yfinance', 5000)
      for (let i = 0; i < 150; i++) {
        monitor.trackError('/equity/price/quote', 'yfinance', error, 5000)
      }

      const metrics = monitor.getMetrics('/equity/price/quote', 'yfinance')
      expect(metrics.get('yfinance:/equity/price/quote')?.errors).toHaveLength(100)
    })
  })

  describe('trackRetry', () => {
    it('increments retry count', () => {
      const error = MarketDataError.providerTimeout('yfinance', 5000)
      monitor.trackRetry('/equity/price/quote', 'yfinance', error, 1)
      monitor.trackRetry('/equity/price/quote', 'yfinance', error, 2)

      const metrics = monitor.getMetrics('/equity/price/quote', 'yfinance')
      expect(metrics.get('yfinance:/equity/price/quote')?.retryCount).toBe(2)
    })
  })

  describe('getMetrics', () => {
    beforeEach(() => {
      monitor.trackRequest('/equity/price/quote', 'yfinance')
      monitor.trackRequest('/crypto/price/historical', 'tradingview')
      monitor.trackRequest('/equity/price/quote', 'fmp')
    })

    it('returns all metrics when no filter', () => {
      const metrics = monitor.getMetrics()
      expect(metrics.size).toBe(3)
    })

    it('filters by endpoint', () => {
      const metrics = monitor.getMetrics('/equity/price/quote')
      expect(metrics.size).toBe(2)
      expect(metrics.has('yfinance:/equity/price/quote')).toBe(true)
      expect(metrics.has('fmp:/equity/price/quote')).toBe(true)
    })

    it('filters by provider', () => {
      const metrics = monitor.getMetrics(undefined, 'yfinance')
      expect(metrics.size).toBe(1)
      expect(metrics.has('yfinance:/equity/price/quote')).toBe(true)
    })

    it('filters by both endpoint and provider', () => {
      const metrics = monitor.getMetrics('/equity/price/quote', 'yfinance')
      expect(metrics.size).toBe(1)
      expect(metrics.has('yfinance:/equity/price/quote')).toBe(true)
    })
  })

  describe('hooks', () => {
    it('calls onRequest hook', () => {
      let called = false
      monitor.setHooks({
        onRequest: (endpoint, provider) => {
          called = true
          expect(endpoint).toBe('/equity/price/quote')
          expect(provider).toBe('yfinance')
        },
      })

      monitor.trackRequest('/equity/price/quote', 'yfinance')
      expect(called).toBe(true)
    })

    it('calls onError and onRateLimit hooks', () => {
      let errorCalled = false
      let rateLimitCalled = false

      monitor.setHooks({
        onError: () => { errorCalled = true },
        onRateLimit: (provider) => {
          rateLimitCalled = true
          expect(provider).toBe('yfinance')
        },
      })

      const error = new MarketDataError(
        MarketDataErrorCode.RATE_LIMIT_EXCEEDED,
        'Rate limit',
        'yfinance'
      )
      monitor.trackError('/equity/price/quote', 'yfinance', error, 100)

      expect(errorCalled).toBe(true)
      expect(rateLimitCalled).toBe(true)
    })
  })

  describe('reset', () => {
    it('clears all metrics', () => {
      monitor.trackRequest('/equity/price/quote', 'yfinance')
      expect(monitor.getMetrics().size).toBe(1)

      monitor.reset()
      expect(monitor.getMetrics().size).toBe(0)
    })
  })
})
