import type { OhlcvData } from '../indicator/types'

interface CacheEntry {
  data: OhlcvData[]
  fetchedAt: number // Date.now()
}

export type OhlcvCache = {
  get: (key: string) => OhlcvData[] | null
  set: (key: string, data: OhlcvData[]) => void
}

export function createOhlcvTtlCache(params?: {
  ttlMs?: number
  maxSize?: number
}): OhlcvCache {
  const ttlMs = params?.ttlMs ?? 2 * 60 * 1000
  const maxSize = params?.maxSize ?? 50

  const map = new Map<string, CacheEntry>()

  function get(key: string): OhlcvData[] | null {
    const entry = map.get(key)
    if (!entry) return null
    if (Date.now() - entry.fetchedAt > ttlMs) {
      map.delete(key)
      return null
    }
    return entry.data
  }

  function set(key: string, data: OhlcvData[]): void {
    if (map.size >= maxSize) {
      const oldest = [...map.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      for (let i = 0; i < Math.ceil(maxSize / 4); i++) {
        map.delete(oldest[i][0])
      }
    }
    map.set(key, { data, fetchedAt: Date.now() })
  }

  return { get, set }
}
