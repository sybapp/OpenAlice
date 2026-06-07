import type { MarketDataAssetClass, MarketDataHistoricalInput } from './types.js'

export interface SectorRotationDataRange {
  from: string
  to: string
  bars: number
}

export interface SectorRotationSymbolResult {
  symbol: string
  startClose: number
  latestClose: number
  returnPct: number
  dataRange: SectorRotationDataRange
}

export interface SectorRotationFailure {
  symbol: string
  error: string
}

export interface SectorRotationResult {
  assetClass: Exclude<MarketDataAssetClass, 'economy' | 'news'>
  interval: string
  benchmark?: SectorRotationSymbolResult
  sectors: SectorRotationSymbolResult[]
  failures: SectorRotationFailure[]
}

export interface SectorRotationInput {
  symbols: string[]
  benchmark?: string
  assetClass?: Exclude<MarketDataAssetClass, 'economy' | 'news'>
  interval?: string
  provider?: string
  start_date?: string
  credentials?: Record<string, string>
}

export interface SectorRotationHistoricalFetcher {
  historical(input: MarketDataHistoricalInput): Promise<{
    rows: Array<Record<string, unknown>>
    error?: string
  }>
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function closeSeries(rows: Array<Record<string, unknown>>): Array<{ date: string; close: number }> {
  return rows
    .map((row) => ({
      date: typeof row.date === 'string' ? row.date : '',
      close: asFiniteNumber(row.close),
    }))
    .filter((row): row is { date: string; close: number } => Boolean(row.date) && row.close !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}

async function calculateOne(
  fetcher: SectorRotationHistoricalFetcher,
  input: Required<Pick<SectorRotationInput, 'assetClass' | 'interval'>> & Pick<SectorRotationInput, 'provider' | 'start_date' | 'credentials'>,
  symbol: string,
): Promise<SectorRotationSymbolResult> {
  const result = await fetcher.historical({
    assetClass: input.assetClass,
    symbol,
    provider: input.provider,
    credentials: input.credentials,
    params: {
      interval: input.interval,
      ...(input.start_date ? { start_date: input.start_date } : {}),
    },
  })

  if (result.error) {
    throw new Error(result.error)
  }

  const data = closeSeries(result.rows)
  if (data.length < 2) {
    throw new Error(`Sector rotation requires at least 2 close prices, got ${data.length}`)
  }

  const first = data[0]
  const last = data[data.length - 1]
  return {
    symbol,
    startClose: first.close,
    latestClose: last.close,
    returnPct: ((last.close - first.close) / first.close) * 100,
    dataRange: {
      from: first.date,
      to: last.date,
      bars: data.length,
    },
  }
}

export async function calculateSectorRotation(
  fetcher: SectorRotationHistoricalFetcher,
  input: SectorRotationInput,
): Promise<SectorRotationResult> {
  const assetClass = input.assetClass ?? 'etf'
  const interval = input.interval ?? '1d'
  const common = {
    assetClass,
    interval,
    provider: input.provider,
    start_date: input.start_date,
    credentials: input.credentials,
  }
  const sectors: SectorRotationSymbolResult[] = []
  const failures: SectorRotationFailure[] = []

  for (const symbol of input.symbols) {
    try {
      sectors.push(await calculateOne(fetcher, common, symbol))
    } catch (error) {
      failures.push({ symbol, error: error instanceof Error ? error.message : String(error) })
    }
  }

  let benchmark: SectorRotationSymbolResult | undefined
  if (input.benchmark) {
    try {
      benchmark = await calculateOne(fetcher, common, input.benchmark)
    } catch (error) {
      failures.push({ symbol: input.benchmark, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    assetClass,
    interval,
    benchmark,
    sectors: sectors.sort((a, b) => b.returnPct - a.returnPct),
    failures,
  }
}
