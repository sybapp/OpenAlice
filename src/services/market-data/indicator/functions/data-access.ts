import type { IndicatorContext, TrackedValues } from '../types.js'

export async function CLOSE(
  symbol: string,
  interval: string,
  context: IndicatorContext,
): Promise<TrackedValues> {
  const { data, meta } = await context.getHistoricalData(symbol, interval)
  return { values: data.map((d) => d.close), source: meta }
}

export async function HIGH(
  symbol: string,
  interval: string,
  context: IndicatorContext,
): Promise<TrackedValues> {
  const { data, meta } = await context.getHistoricalData(symbol, interval)
  return { values: data.map((d) => d.high), source: meta }
}

export async function LOW(
  symbol: string,
  interval: string,
  context: IndicatorContext,
): Promise<TrackedValues> {
  const { data, meta } = await context.getHistoricalData(symbol, interval)
  return { values: data.map((d) => d.low), source: meta }
}

export async function OPEN(
  symbol: string,
  interval: string,
  context: IndicatorContext,
): Promise<TrackedValues> {
  const { data, meta } = await context.getHistoricalData(symbol, interval)
  return { values: data.map((d) => d.open), source: meta }
}

export async function VOLUME(
  symbol: string,
  interval: string,
  context: IndicatorContext,
): Promise<TrackedValues> {
  const { data, meta } = await context.getHistoricalData(symbol, interval)
  return { values: data.map((d) => d.volume ?? 0), source: meta }
}
