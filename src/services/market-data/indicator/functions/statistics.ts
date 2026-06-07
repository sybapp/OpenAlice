import { toValues, type TrackedValues } from '../types.js'

type NumericInput = number[] | TrackedValues

export function SMA(data: NumericInput, period: number): number {
  const v = toValues(data)
  if (v.length < period) {
    throw new Error(`SMA requires at least ${period} data points, got ${v.length}`)
  }
  const slice = v.slice(-period)
  const sum = slice.reduce((acc, val) => acc + val, 0)
  return sum / period
}

export function EMA(data: NumericInput, period: number): number {
  const v = toValues(data)
  if (v.length < period) {
    throw new Error(`EMA requires at least ${period} data points, got ${v.length}`)
  }
  const multiplier = 2 / (period + 1)
  let ema = v.slice(0, period).reduce((acc, val) => acc + val, 0) / period
  for (let i = period; i < v.length; i++) {
    ema = (v[i] - ema) * multiplier + ema
  }
  return ema
}

export function STDEV(data: NumericInput): number {
  const v = toValues(data)
  if (v.length === 0) {
    throw new Error('STDEV requires at least 1 data point')
  }
  const mean = v.reduce((acc, val) => acc + val, 0) / v.length
  const variance = v.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / v.length
  return Math.sqrt(variance)
}

export function MAX(data: NumericInput): number {
  const v = toValues(data)
  if (v.length === 0) {
    throw new Error('MAX requires at least 1 data point')
  }
  return Math.max(...v)
}

export function MIN(data: NumericInput): number {
  const v = toValues(data)
  if (v.length === 0) {
    throw new Error('MIN requires at least 1 data point')
  }
  return Math.min(...v)
}

export function SUM(data: NumericInput): number {
  const v = toValues(data)
  return v.reduce((acc, val) => acc + val, 0)
}

export function AVERAGE(data: NumericInput): number {
  const v = toValues(data)
  if (v.length === 0) {
    throw new Error('AVERAGE requires at least 1 data point')
  }
  return v.reduce((acc, val) => acc + val, 0) / v.length
}
