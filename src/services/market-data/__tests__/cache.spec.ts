import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { MarketDataCache } from '../cache.js'

describe('MarketDataCache', () => {
  let cache: MarketDataCache

  beforeEach(() => {
    vi.useFakeTimers()
    cache = new MarketDataCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('symbolSearch cache', () => {
    it('stores and retrieves symbol search results', () => {
      const data = [{ symbol: 'AAPL', name: 'Apple Inc.' }]
      cache.setSymbolSearch('equity:AAPL', data)

      const result = cache.getSymbolSearch('equity:AAPL')
      expect(result).toEqual(data)
    })

    it('returns null for missing key', () => {
      expect(cache.getSymbolSearch('nonexistent')).toBeNull()
    })

    it('expires after TTL', () => {
      const data = [{ symbol: 'AAPL' }]
      cache.setSymbolSearch('equity:AAPL', data)

      vi.advanceTimersByTime(3600001) // 1 hour + 1ms
      expect(cache.getSymbolSearch('equity:AAPL')).toBeNull()
    })

    it('respects custom TTL', () => {
      const customCache = new MarketDataCache({ symbolSearchTTL: 1000 })
      customCache.setSymbolSearch('test', { data: 'test' })

      vi.advanceTimersByTime(999)
      expect(customCache.getSymbolSearch('test')).toEqual({ data: 'test' })

      vi.advanceTimersByTime(2)
      expect(customCache.getSymbolSearch('test')).toBeNull()
    })
  })

  describe('historical cache', () => {
    it('stores and retrieves historical data', () => {
      const data = [{ date: '2024-01-01', close: 100 }]
      cache.setHistorical('AAPL:1d', data)

      const result = cache.getHistorical('AAPL:1d')
      expect(result).toEqual(data)
    })

    it('expires after TTL', () => {
      const data = [{ date: '2024-01-01', close: 100 }]
      cache.setHistorical('AAPL:1d', data)

      vi.advanceTimersByTime(300001) // 5 min + 1ms
      expect(cache.getHistorical('AAPL:1d')).toBeNull()
    })

    it('respects custom TTL', () => {
      const customCache = new MarketDataCache({ historicalDataTTL: 2000 })
      customCache.setHistorical('test', { data: 'test' })

      vi.advanceTimersByTime(1999)
      expect(customCache.getHistorical('test')).toEqual({ data: 'test' })

      vi.advanceTimersByTime(2)
      expect(customCache.getHistorical('test')).toBeNull()
    })
  })

  describe('clear', () => {
    it('clears all caches', () => {
      cache.setSymbolSearch('key1', { data: 'search' })
      cache.setHistorical('key2', { data: 'historical' })

      cache.clear()

      expect(cache.getSymbolSearch('key1')).toBeNull()
      expect(cache.getHistorical('key2')).toBeNull()
    })
  })

  describe('cache isolation', () => {
    it('symbol search and historical caches are independent', () => {
      cache.setSymbolSearch('AAPL', { type: 'search' })
      cache.setHistorical('AAPL', { type: 'historical' })

      expect(cache.getSymbolSearch('AAPL')).toEqual({ type: 'search' })
      expect(cache.getHistorical('AAPL')).toEqual({ type: 'historical' })
    })
  })
})
