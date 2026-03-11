import type { OhlcvData } from '../indicator/types'
import { parseIntervalToMinutes } from './interval'

export type OhlcvClient = {
  getHistorical: (params: Record<string, unknown>) => Promise<unknown[]>
}

function sortByDateAsc(data: OhlcvData[]): OhlcvData[] {
  // in-place sort (matches existing behavior)
  return data.sort((a, b) => a.date.localeCompare(b.date))
}

function buildStartDateFromCalendarDays(calendarDays: number): string {
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - calendarDays)
  return startDate.toISOString().slice(0, 10)
}

/**
 * Calendar-days strategy (existing calculateIndicator behavior)
 */
export async function fetchOhlcvByCalendarDays(params: {
  client: OhlcvClient
  symbol: string
  interval: string
  calendarDays: number
}): Promise<OhlcvData[]> {
  const { client, symbol, interval, calendarDays } = params
  const start_date = buildStartDateFromCalendarDays(calendarDays)

  const results = await client.getHistorical({ symbol, start_date, interval }) as OhlcvData[]
  return sortByDateAsc(results)
}

/**
 * Bars-window strategy: fetch enough calendar days, then slice(-lookbackBars).
 * This gives deterministic lookback length when data is sufficient.
 */
export async function fetchOhlcvByBars(params: {
  client: OhlcvClient
  symbol: string
  interval: string
  lookbackBars: number
  paddingBars?: number
}): Promise<OhlcvData[]> {
  const { client, symbol, interval, lookbackBars, paddingBars } = params
  const pad = paddingBars ?? Math.ceil(lookbackBars * 0.25)

  if (!Number.isFinite(lookbackBars) || lookbackBars <= 0) {
    throw new Error(`lookbackBars must be positive, got ${lookbackBars}`)
  }

  const minutes = parseIntervalToMinutes(interval)
  if (!minutes) {
    throw new Error(`Unsupported interval: ${interval}`)
  }

  const totalBarsToFetch = lookbackBars + pad
  const totalMinutes = totalBarsToFetch * minutes
  const totalDays = Math.ceil(totalMinutes / (60 * 24))
  const calendarDays = Math.max(1, totalDays)

  const start_date = buildStartDateFromCalendarDays(calendarDays)
  const results = await client.getHistorical({ symbol, start_date, interval }) as OhlcvData[]
  sortByDateAsc(results)

  // Enforce exact lookback when data is sufficient
  if (results.length <= lookbackBars) return results
  return results.slice(-lookbackBars)
}
