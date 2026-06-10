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

export function MEDIAN(data: NumericInput): number {
  const v = [...toValues(data)].sort((a, b) => a - b)
  if (v.length === 0) {
    throw new Error('MEDIAN requires at least 1 data point')
  }
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function ROC(data: NumericInput, period: number): number {
  const v = toValues(data)
  if (v.length < period + 1) {
    throw new Error(`ROC requires at least ${period + 1} data points, got ${v.length}`)
  }
  const cur = v[v.length - 1]
  const prior = v[v.length - 1 - period]
  return prior === 0 ? 0 : ((cur - prior) / prior) * 100
}

export function ZSCORE(data: NumericInput, period?: number): number {
  const all = toValues(data)
  if (all.length === 0) {
    throw new Error('ZSCORE requires at least 1 data point')
  }
  const v = period ? all.slice(-period) : all
  const mean = v.reduce((acc, val) => acc + val, 0) / v.length
  const variance = v.reduce((acc, val) => acc + (val - mean) ** 2, 0) / v.length
  const sd = Math.sqrt(variance)
  const last = all[all.length - 1]
  return sd === 0 ? 0 : (last - mean) / sd
}

export function SLOPE(data: NumericInput, period: number): number {
  const v = toValues(data).slice(-period)
  const n = v.length
  if (n < 2) {
    throw new Error(`SLOPE requires at least 2 data points, got ${n}`)
  }
  const sumX = (n * (n - 1)) / 2
  const sumXX = ((n - 1) * n * (2 * n - 1)) / 6
  const sumY = v.reduce((acc, y) => acc + y, 0)
  const sumXY = v.reduce((acc, y, i) => acc + i * y, 0)
  const denom = n * sumXX - sumX * sumX
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom
}

export function CORRELATION(a: NumericInput, b: NumericInput): number {
  const av = toValues(a)
  const bv = toValues(b)
  const n = Math.min(av.length, bv.length)
  if (n < 2) {
    throw new Error(`CORRELATION requires at least 2 aligned points, got ${n}`)
  }
  const A = av.slice(-n)
  const B = bv.slice(-n)
  const meanA = A.reduce((sum, x) => sum + x, 0) / n
  const meanB = B.reduce((sum, x) => sum + x, 0) / n
  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const da = A[i] - meanA
    const db = B[i] - meanB
    cov += da * db
    varA += da * da
    varB += db * db
  }
  const denom = Math.sqrt(varA * varB)
  return denom === 0 ? 0 : cov / denom
}

export function HIGHEST(data: NumericInput, period: number): number {
  const v = toValues(data).slice(-period)
  if (v.length === 0) {
    throw new Error('HIGHEST requires at least 1 data point')
  }
  return Math.max(...v)
}

export function LOWEST(data: NumericInput, period: number): number {
  const v = toValues(data).slice(-period)
  if (v.length === 0) {
    throw new Error('LOWEST requires at least 1 data point')
  }
  return Math.min(...v)
}
