/**
 * Analysis Kit — 统一量化因子计算工具
 *
 * 通过 asset 参数区分资产类别（equity/crypto/currency），
 * 公式语法完全一样：CLOSE('AAPL', '1d')、SMA(...)、RSI(...) 等。
 * 数据带 TTL 内存缓存，同一 symbol+interval 在缓存有效期内只拉一次。
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import { IndicatorCalculator } from './indicator/calculator'
import type { IndicatorContext, OhlcvData } from './indicator/types'

// ─── In-memory OHLCV cache with TTL ──────────────────────────────────────────
interface CacheEntry {
  data: OhlcvData[]
  fetchedAt: number // Date.now()
}

const ohlcvCache = new Map<string, CacheEntry>()

/** Cache TTL in ms — data is reused within this window (default: 2 minutes) */
const CACHE_TTL_MS = 2 * 60 * 1000

/** Max cache entries to prevent unbounded memory growth */
const CACHE_MAX_SIZE = 50

function getCacheKey(asset: string, symbol: string, interval: string): string {
  return `${asset}:${symbol}:${interval}`
}

function getCached(key: string): OhlcvData[] | null {
  const entry = ohlcvCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    ohlcvCache.delete(key)
    return null
  }
  return entry.data
}

function setCache(key: string, data: OhlcvData[]): void {
  // Evict oldest entries if cache is full
  if (ohlcvCache.size >= CACHE_MAX_SIZE) {
    const oldest = [...ohlcvCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
    for (let i = 0; i < Math.ceil(CACHE_MAX_SIZE / 4); i++) {
      ohlcvCache.delete(oldest[i][0])
    }
  }
  ohlcvCache.set(key, { data, fetchedAt: Date.now() })
}

// ─── Date range calculation ──────────────────────────────────────────────────

/**
 * Calculate calendar days to fetch based on interval.
 * Optimized to fetch only what's needed for common indicators (e.g. RSI-14, EMA-20, BBANDS-20).
 * Most indicators need ~200 bars max; we fetch with ~2x buffer.
 */
function getCalendarDays(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 90 // fallback: 3 months

  const n = parseInt(match[1])
  const unit = match[2]

  switch (unit) {
    case 'd': return n * 400   // 日线：~400 trading days ≈ 1.5 years
    case 'w': return n * 1400  // 周线：~1400 days ≈ 4 years
    case 'h': return n * 14    // 小时线：14 天 (enough for ~200+ bars)
    case 'm': return n * 7     // 分钟线：7 天 (15m × 7d ≈ 672 bars, plenty)
    default:  return 90
  }
}

function buildStartDate(interval: string): string {
  const calendarDays = getCalendarDays(interval)
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - calendarDays)
  return startDate.toISOString().slice(0, 10)
}

// ─── Context builder with caching ────────────────────────────────────────────

function buildContext(
  asset: 'equity' | 'crypto' | 'currency',
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
): IndicatorContext {
  return {
    getHistoricalData: async (symbol, interval) => {
      const cacheKey = getCacheKey(asset, symbol, interval)

      // Check cache first
      const cached = getCached(cacheKey)
      if (cached) {
        return cached
      }

      // Cache miss — fetch from API
      const start_date = buildStartDate(interval)

      let results: OhlcvData[]
      switch (asset) {
        case 'equity':
          results = await equityClient.getHistorical({ symbol, start_date, interval }) as OhlcvData[]
          break
        case 'crypto':
          results = await cryptoClient.getHistorical({ symbol, start_date, interval }) as OhlcvData[]
          break
        case 'currency':
          results = await currencyClient.getHistorical({ symbol, start_date, interval }) as OhlcvData[]
          break
      }

      results.sort((a, b) => a.date.localeCompare(b.date))

      // Store in cache
      setCache(cacheKey, results)

      return results
    },
  }
}

// ─── Tool export ─────────────────────────────────────────────────────────────

export function createAnalysisTools(
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
) {
  return {
    calculateIndicator: tool({
      description: `Calculate technical indicators for any asset (equity, crypto, currency) using formula expressions.

Asset classes: "equity" for stocks, "crypto" for cryptocurrencies, "currency" for forex pairs.

Data access: CLOSE('AAPL', '1d'), HIGH, LOW, OPEN, VOLUME — args: symbol, interval (e.g. '1d', '1w', '1h').
Statistics: SMA(data, period), EMA, STDEV, MAX, MIN, SUM, AVERAGE.
Technical: RSI(data, 14), BBANDS(data, 20, 2), MACD(data, 12, 26, 9), ATR(highs, lows, closes, 14).
Array access: CLOSE('AAPL', '1d')[-1] for latest price. Supports +, -, *, / operators.

Examples:
  asset="equity":   SMA(CLOSE('AAPL', '1d'), 50)
  asset="crypto":   RSI(CLOSE('BTCUSD', '1d'), 14)
  asset="currency": CLOSE('EURUSD', '1d')[-1]

Use the corresponding search tool first to resolve the correct symbol.`,
      inputSchema: z.object({
        asset: z.enum(['equity', 'crypto', 'currency']).describe('Asset class'),
        formula: z.string().describe("Formula expression, e.g. SMA(CLOSE('AAPL', '1d'), 50)"),
        precision: z.number().int().min(0).max(10).optional().describe('Decimal places (default: 4)'),
      }),
      execute: async ({ asset, formula, precision }) => {
        const context = buildContext(asset, equityClient, cryptoClient, currencyClient)
        const calculator = new IndicatorCalculator(context)
        return await calculator.calculate(formula, precision)
      },
    }),
  }
}
