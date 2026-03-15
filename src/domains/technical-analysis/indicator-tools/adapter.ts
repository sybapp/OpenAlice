import { tool } from 'ai'
import { z } from 'zod'
import { IndicatorCalculator, getCalendarDaysForInterval } from '@/domains/technical-analysis/indicator-kit/index'
import type { IndicatorContext, OhlcvStore } from '@/domains/technical-analysis/indicator-kit/index'

export function createIndicatorTools(store: OhlcvStore) {
  return {
    calculateIndicator: tool({
      description: `Calculate crypto technical indicators using formula expressions.

Asset class: "crypto" for cryptocurrencies.

Data access: CLOSE('BTC/USDT', '1d'), HIGH, LOW, OPEN, VOLUME — args: symbol, interval (e.g. '1d', '1w', '1h').
Statistics: SMA(data, period), EMA, STDEV, MAX, MIN, SUM, AVERAGE.
Technical: RSI(data, 14), BBANDS(data, 20, 2), MACD(data, 12, 26, 9), ATR(highs, lows, closes, 14).
Array access: CLOSE('BTC/USDT', '1d')[-1] for latest price. Supports +, -, *, / operators.

Examples:
  asset="crypto": RSI(CLOSE('BTC/USDT', '1d'), 14)
  asset="crypto": SMA(CLOSE('ETH/USDT', '4h'), 50)

Use the corresponding search tool first to resolve the correct symbol.`,
      inputSchema: z.object({
        asset: z.literal('crypto').describe('Asset class'),
        formula: z.string().describe("Formula expression, e.g. SMA(CLOSE('BTC/USDT', '1d'), 50)"),
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
