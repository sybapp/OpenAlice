import { tool } from 'ai'
import { z } from 'zod'
import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import { IndicatorCalculator, fetchOhlcvByCalendarDays, createOhlcvTtlCache, getCalendarDaysForInterval } from '@/extension/indicator-kit/index'
import type { IndicatorContext, OhlcvData } from '@/extension/indicator-kit/index'

const ohlcvCache = createOhlcvTtlCache()

function getCacheKey(asset: string, symbol: string, interval: string): string {
  return `${asset}:${symbol}:${interval}`
}

function buildContext(
  asset: 'equity' | 'crypto' | 'currency',
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
): IndicatorContext {
  return {
    getHistoricalData: async (symbol, interval) => {
      const cacheKey = getCacheKey(asset, symbol, interval)
      const cached = ohlcvCache.get(cacheKey)
      if (cached) return cached

      const calendarDays = getCalendarDaysForInterval(interval)

      let results: OhlcvData[]
      switch (asset) {
        case 'equity':
          results = await fetchOhlcvByCalendarDays({ client: equityClient, symbol, interval, calendarDays })
          break
        case 'crypto':
          results = await fetchOhlcvByCalendarDays({ client: cryptoClient, symbol, interval, calendarDays })
          break
        case 'currency':
          results = await fetchOhlcvByCalendarDays({ client: currencyClient, symbol, interval, calendarDays })
          break
      }

      ohlcvCache.set(cacheKey, results)
      return results
    },
  }
}

export function createIndicatorTools(
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
