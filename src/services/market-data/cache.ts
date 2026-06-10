export interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
}

export interface CacheOptions {
  symbolSearchTTL?: number
  historicalDataTTL?: number
}

const DEFAULT_SYMBOL_SEARCH_TTL = 3600000 // 1 hour
const DEFAULT_HISTORICAL_DATA_TTL = 300000 // 5 minutes

export class MarketDataCache {
  private symbolSearchCache = new Map<string, CacheEntry<any>>()
  private historicalCache = new Map<string, CacheEntry<any>>()
  private symbolSearchTTL: number
  private historicalDataTTL: number

  constructor(options: CacheOptions = {}) {
    this.symbolSearchTTL = options.symbolSearchTTL ?? DEFAULT_SYMBOL_SEARCH_TTL
    this.historicalDataTTL = options.historicalDataTTL ?? DEFAULT_HISTORICAL_DATA_TTL
  }

  getSymbolSearch(key: string): any | null {
    return this.get(this.symbolSearchCache, key)
  }

  setSymbolSearch(key: string, data: any): void {
    this.set(this.symbolSearchCache, key, data, this.symbolSearchTTL)
  }

  getHistorical(key: string): any | null {
    return this.get(this.historicalCache, key)
  }

  setHistorical(key: string, data: any): void {
    this.set(this.historicalCache, key, data, this.historicalDataTTL)
  }

  clear(): void {
    this.symbolSearchCache.clear()
    this.historicalCache.clear()
  }

  private get(cache: Map<string, CacheEntry<any>>, key: string): any | null {
    const entry = cache.get(key)
    if (!entry) return null

    if (Date.now() - entry.timestamp > entry.ttl) {
      cache.delete(key)
      return null
    }

    return entry.data
  }

  private set(cache: Map<string, CacheEntry<any>>, key: string, data: any, ttl: number): void {
    cache.set(key, { data, timestamp: Date.now(), ttl })
  }
}

export const globalCache = new MarketDataCache()
