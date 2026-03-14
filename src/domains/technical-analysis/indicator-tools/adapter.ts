import { tool } from 'ai'
import { z } from 'zod'
import { IndicatorCalculator, getCalendarDaysForInterval } from '@/domains/technical-analysis/indicator-kit/index'
import type { IndicatorContext, OhlcvStore } from '@/domains/technical-analysis/indicator-kit/index'

export function createIndicatorTools(store: OhlcvStore) {
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
        dropUnclosed: z.boolean().optional().describe('Drop the latest still-open bar before indicator calculation (default: false)'),
      }),
      execute: async ({ asset, formula, precision, dropUnclosed }) => {
        const context: IndicatorContext = {
          getHistoricalData: (symbol, interval) =>
            store.fetch({
              asset,
              symbol,
              interval,
              strategy: 'calendar',
              calendarDays: getCalendarDaysForInterval(interval),
              dropUnclosed,
            }),
        }

        const calculator = new IndicatorCalculator(context)
        return await calculator.calculate(formula, precision)
      },
    }),
  }
}
