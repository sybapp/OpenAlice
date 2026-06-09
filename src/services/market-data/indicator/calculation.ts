import type {
  CommodityClientLike,
  CryptoClientLike,
  CurrencyClientLike,
  EquityClientLike,
} from '@/domain/market-data/client/types.js'
import { IndicatorCalculator, type CalculateOutput } from './calculator.js'
import type {
  DataSourceMeta,
  HistoricalDataResult,
  IndicatorContext,
  OhlcvData,
} from './types.js'

export type IndicatorAssetClass = 'equity' | 'crypto' | 'currency' | 'commodity'

export interface IndicatorCalculationInput {
  asset: IndicatorAssetClass
  formula: string
  precision?: number
  provider?: string
  credentials?: Record<string, string>
}

export interface IndicatorClientBundle {
  equityClient: EquityClientLike
  cryptoClient: CryptoClientLike
  currencyClient: CurrencyClientLike
  commodityClient: CommodityClientLike
}

export interface IndicatorHistoricalFetcher {
  historical(input: {
    assetClass: IndicatorAssetClass
    symbol: string
    provider?: string
    limit?: number
    params?: Record<string, unknown>
    credentials?: Record<string, string>
  }): Promise<{
    rows: Array<Record<string, unknown>>
    error?: string
  }>
}

function getCalendarDays(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 365

  const n = parseInt(match[1])
  const unit = match[2]

  switch (unit) {
    case 'd': return n * 730
    case 'w': return n * 1825
    case 'h': return n * 90
    case 'm': return n * 30
    default:  return 365
  }
}

export function buildIndicatorStartDate(interval: string): string {
  const calendarDays = getCalendarDays(interval)
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - calendarDays)
  return startDate.toISOString().slice(0, 10)
}

function normalizeHistoricalRows(symbol: string, raw: Array<Record<string, unknown>>): HistoricalDataResult {
  const data = raw.filter(
    (d): d is Record<string, unknown> & OhlcvData =>
      d.close != null && d.open != null && d.high != null && d.low != null,
  ) as OhlcvData[]

  data.sort((a, b) => a.date.localeCompare(b.date))

  const meta: DataSourceMeta = {
    symbol,
    from: data.length > 0 ? data[0].date : '',
    to: data.length > 0 ? data[data.length - 1].date : '',
    bars: data.length,
  }

  return { data, meta }
}

export function buildClientIndicatorContext(
  asset: IndicatorAssetClass,
  clients: IndicatorClientBundle,
): IndicatorContext {
  return {
    getHistoricalData: async (symbol, interval): Promise<HistoricalDataResult> => {
      const start_date = buildIndicatorStartDate(interval)

      let raw: Array<Record<string, unknown>>
      switch (asset) {
        case 'equity':
          raw = await clients.equityClient.getHistorical({ symbol, start_date, interval })
          break
        case 'crypto':
          raw = await clients.cryptoClient.getHistorical({ symbol, start_date, interval })
          break
        case 'currency':
          raw = await clients.currencyClient.getHistorical({ symbol, start_date, interval })
          break
        case 'commodity':
          raw = await clients.commodityClient.getSpotPrices({ symbol, start_date })
          break
      }

      return normalizeHistoricalRows(symbol, raw)
    },
  }
}

export function buildServiceIndicatorContext(
  asset: IndicatorAssetClass,
  fetcher: IndicatorHistoricalFetcher,
  options: Pick<IndicatorCalculationInput, 'provider' | 'credentials'> = {},
): IndicatorContext {
  return {
    getHistoricalData: async (symbol, interval): Promise<HistoricalDataResult> => {
      const start_date = buildIndicatorStartDate(interval)
      const result = await fetcher.historical({
        assetClass: asset,
        symbol,
        provider: options.provider,
        credentials: options.credentials,
        params: asset === 'commodity' ? { start_date } : { start_date, interval },
      })

      if (result.error) {
        throw new Error(result.error)
      }

      return normalizeHistoricalRows(symbol, result.rows)
    },
  }
}

export async function calculateIndicatorWithContext(
  input: Pick<IndicatorCalculationInput, 'formula' | 'precision'>,
  context: IndicatorContext,
): Promise<CalculateOutput> {
  const calculator = new IndicatorCalculator(context)
  return await calculator.calculate(input.formula, input.precision)
}

export async function calculateIndicatorWithClients(
  input: Pick<IndicatorCalculationInput, 'asset' | 'formula' | 'precision'>,
  clients: IndicatorClientBundle,
): Promise<CalculateOutput> {
  return await calculateIndicatorWithContext(
    input,
    buildClientIndicatorContext(input.asset, clients),
  )
}

export async function calculateIndicatorWithService(
  input: IndicatorCalculationInput,
  fetcher: IndicatorHistoricalFetcher,
): Promise<CalculateOutput> {
  return await calculateIndicatorWithContext(
    input,
    buildServiceIndicatorContext(input.asset, fetcher, input),
  )
}
