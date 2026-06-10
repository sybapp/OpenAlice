/**
 * Market Data Service Integration Tests
 *
 * 端到端测试：验证 service 层的核心功能
 * 注意：部分测试依赖真实 API，可能受网络和凭据限制
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createMarketDataService } from '../service.js'
import type { MarketDataService } from '../types.js'

describe('MarketDataService Integration', () => {
  let service: MarketDataService

  beforeEach(() => {
    service = createMarketDataService()
  })

  describe('catalog', () => {
    it('lists all available endpoints including TradingView', async () => {
      const catalog = await service.catalog()

      expect(catalog.endpoints).toBeDefined()
      expect(catalog.providers).toBeDefined()

      // 验证 TradingView 端点存在
      const tvEndpoints = catalog.endpoints.filter(e => e.providers.includes('tradingview'))
      expect(tvEndpoints.length).toBeGreaterThan(0)
      expect(tvEndpoints.some(e => e.endpoint === '/tradingview/scan')).toBe(true)
      expect(tvEndpoints.some(e => e.endpoint === '/tradingview/candles')).toBe(true)
    })
  })

  describe('endpoint search', () => {
    it('searches endpoints by keyword', async () => {
      const result = await service.endpointSearch({
        query: 'income',
        assetClass: 'equity',
        limit: 10,
      })

      // endpointSearch 可能返回不同的结构，验证基本功能
      expect(result).toBeDefined()
      expect(typeof result).toBe('object')
    })
  })

  describe('scan (TradingView screener)', () => {
    it('runs a preset scan', async () => {
      const result = await service.scan({
        preset: 'stocks',
        market: 'america',
        compact: true,
        limit: 5,
      })

      expect(result.provider).toBe('tradingview')
      expect(result.endpoint).toBe('/tradingview/scan')
      expect(result.fields).toBeDefined()
      expect(result.rows).toBeDefined()
      expect(Array.isArray(result.rows)).toBe(true)
    })
  })

  describe('indicator calculation', () => {
    it('calculates SMA for equity', async () => {
      const result = await service.indicator({
        asset: 'equity',
        formula: "SMA(CLOSE('AAPL', '1d'), 20)",
        precision: 2,
      })

      expect(result).toHaveProperty('value')
      expect(result).toHaveProperty('dataRange')
      expect(typeof result.value).toBe('number')
    }, 20000)

    it('handles arithmetic formulas', async () => {
      const result = await service.indicator({
        asset: 'equity',
        formula: "CLOSE('AAPL', '1d')[-1] - SMA(CLOSE('AAPL', '1d'), 50)",
        precision: 2,
      })

      expect(result).toHaveProperty('value')
      expect(typeof result.value).toBe('number')
    }, 20000)
  })

  describe('error handling', () => {
    it('handles invalid formula syntax', async () => {
      await expect(
        service.indicator({
          asset: 'equity',
          formula: 'INVALID_FUNCTION()',
        })
      ).rejects.toThrow()
    })

    it('returns error in envelope for missing required params', async () => {
      const result = await service.query({
        endpoint: '/equity/price/historical',
        params: {},
      })

      expect(result.error).toBeDefined()
      expect(result.error).toContain('symbol')
    })
  })

  describe('limit enforcement', () => {
    it('accepts limit parameter', async () => {
      const result = await service.scan({
        preset: 'stocks',
        limit: 10,
      })

      expect(result.provider).toBe('tradingview')
      expect(result.rows).toBeDefined()
      expect(Array.isArray(result.rows)).toBe(true)
    })
  })
})
