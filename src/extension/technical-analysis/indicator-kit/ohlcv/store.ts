import type { OhlcvData } from '../indicator/types'
import type { OhlcvClient } from './fetch'
import { createOhlcvTtlCache } from './cache'
import { fetchOhlcvByBars, fetchOhlcvByCalendarDays } from './fetch'
import { parseIntervalToMinutes } from './interval'

export type AssetClass = 'equity' | 'crypto' | 'currency'

export interface OhlcvStore {
  fetch(params: {
    asset: AssetClass
    symbol: string
    interval: string
    strategy: 'bars' | 'calendar'
    lookbackBars?: number // strategy=bars 时必填
    calendarDays?: number // strategy=calendar 时必填
    dropUnclosed?: boolean // 默认 false
  }): Promise<OhlcvData[]>

  clear(): void
}

function buildCacheKey(params: {
  asset: AssetClass
  symbol: string
  interval: string
  strategy: 'bars' | 'calendar'
  lookbackBars?: number
  calendarDays?: number
}): string {
  const { asset, symbol, interval, strategy } = params

  if (strategy === 'bars') {
    return `${asset}:${symbol}:${interval}:bars:${params.lookbackBars}`
  }

  return `${asset}:${symbol}:${interval}:calendar:${params.calendarDays}`
}

function dropUnclosedBar(bars: OhlcvData[], interval: string): OhlcvData[] {
  if (bars.length === 0) return bars
  const last = bars[bars.length - 1]
  const minutes = parseIntervalToMinutes(interval)
  if (!minutes) return bars
  const barEnd = new Date(last.date).getTime() + minutes * 60_000
  return barEnd > Date.now() ? bars.slice(0, -1) : bars
}

export function createOhlcvStore(params: {
  equityClient: OhlcvClient
  cryptoClient: OhlcvClient
  currencyClient: OhlcvClient
  ttlMs?: number // 默认 120_000
  maxSize?: number // 默认 50
}): OhlcvStore {
  const ttlMs = params.ttlMs
  const maxSize = params.maxSize

  let cache = createOhlcvTtlCache({ ttlMs, maxSize })
  const inFlight = new Map<string, Promise<OhlcvData[]>>()

  function pickClient(asset: AssetClass): OhlcvClient {
    switch (asset) {
      case 'equity': return params.equityClient
      case 'crypto': return params.cryptoClient
      case 'currency': return params.currencyClient
    }
  }

  async function fetchRaw(input: {
    asset: AssetClass
    symbol: string
    interval: string
    strategy: 'bars' | 'calendar'
    lookbackBars?: number
    calendarDays?: number
  }): Promise<OhlcvData[]> {
    const key = buildCacheKey(input)

    const cached = cache.get(key)
    if (cached) return cached

    const existing = inFlight.get(key)
    if (existing) return existing

    const promise = (async () => {
      const client = pickClient(input.asset)

      let bars: OhlcvData[]
      if (input.strategy === 'bars') {
        if (!input.lookbackBars) {
          throw new Error('lookbackBars is required when strategy="bars"')
        }
        bars = await fetchOhlcvByBars({
          client,
          symbol: input.symbol,
          interval: input.interval,
          lookbackBars: input.lookbackBars,
        })
      } else {
        if (!input.calendarDays) {
          throw new Error('calendarDays is required when strategy="calendar"')
        }
        bars = await fetchOhlcvByCalendarDays({
          client,
          symbol: input.symbol,
          interval: input.interval,
          calendarDays: input.calendarDays,
        })
      }

      cache.set(key, bars)
      return bars
    })()

    inFlight.set(key, promise)

    try {
      return await promise
    } finally {
      // 只要请求结束（成功/失败）都释放 in-flight
      if (inFlight.get(key) === promise) inFlight.delete(key)
    }
  }

  return {
    fetch: async (input) => {
      const raw = await fetchRaw(input)
      if (input.dropUnclosed) {
        return dropUnclosedBar(raw, input.interval)
      }
      return raw
    },
    clear: () => {
      cache = createOhlcvTtlCache({ ttlMs, maxSize })
      inFlight.clear()
    },
  }
}

// 仅用于测试导出
export const __private__ = {
  dropUnclosedBar,
  buildCacheKey,
}
