import type {
  BarMeta,
  BarService,
} from '@/domain/market-data/bars/index.js'
import type { OrderFlowContextAnalysis } from '@/domain/analysis/technical-analysis/order-flow/context.js'
import type { AnalyzePriceActionBarsOptions, PriceActionAnalysisResult } from '@/domain/analysis/technical-analysis/price-action/analyze.js'
import type { TrendDirection } from '@/domain/analysis/technical-analysis/price-action/types.js'
import {
  type TechnicalAnalysisEmaBias,
  type TechnicalAnalysisIndicatorOptions,
  type TechnicalAnalysisIndicatorResult,
  type TechnicalAnalysisVwapRelation,
} from './indicators.js'
import { analyzeTechnicalAnalysisInterval } from './interval-analysis.js'

export type TechnicalAnalysisMode = 'context' | 'execution' | 'debug'
export type TechnicalAnalysisIntervalStatus = 'ok' | 'insufficient' | 'error'

export interface TechnicalAnalysisSourceRequest {
  barId: string
  assetClass?: 'equity' | 'crypto' | 'currency' | 'commodity'
}

export interface AnalyzeTechnicalAnalysisParams extends TechnicalAnalysisSourceRequest {
  interval?: string
  intervals?: string[]
  count?: number
  start?: string
  end?: string
  mode?: TechnicalAnalysisMode
  indicators?: TechnicalAnalysisIndicatorOptions
  priceAction?: AnalyzePriceActionBarsOptions
  numBins?: number
}

export interface TechnicalAnalysisIntervalSummary {
  price?: number
  trend: TrendDirection
  emaBias: TechnicalAnalysisEmaBias
  vwapRelation: TechnicalAnalysisVwapRelation
  confluenceScore?: number
  confluenceZoneCount: number
  fvgCount: number
  ifvgCount: number
  orderBlockCount: number
  liquidityPoolCount: number
  orderFlowStatus: OrderFlowContextAnalysis['status']
  warnings: string[]
}

export interface TechnicalAnalysisIntervalResult {
  interval: string
  status: TechnicalAnalysisIntervalStatus
  summary?: TechnicalAnalysisIntervalSummary
  indicators?: TechnicalAnalysisIndicatorResult
  priceAction?: PriceActionAnalysisResult
  orderFlow?: OrderFlowContextAnalysis
  meta?: BarMeta
  error?: string
}

export interface TechnicalAnalysisSummary {
  bias: TrendDirection | 'mixed'
  alignment: 'aligned' | 'conflicted' | 'mixed' | 'unknown'
  conflicts: string[]
  confluences: string[]
  warnings: string[]
}

export interface TechnicalAnalysisResult {
  status: 'ok' | 'partial' | 'insufficient' | 'error'
  summary: TechnicalAnalysisSummary
  intervals: TechnicalAnalysisIntervalResult[]
}

function summarizeIntervals(intervals: TechnicalAnalysisIntervalResult[]): TechnicalAnalysisSummary {
  const successful = intervals.filter((entry) => entry.status === 'ok' && entry.summary)
  if (successful.length === 0) {
    return {
      bias: 'unknown',
      alignment: 'unknown',
      conflicts: [],
      confluences: [],
      warnings: intervals.map((entry) => entry.error).filter((error): error is string => Boolean(error)),
    }
  }

  const bullish = successful.filter((entry) => entry.summary!.trend === 'bullish').length
  const bearish = successful.filter((entry) => entry.summary!.trend === 'bearish').length
  const bias: TechnicalAnalysisSummary['bias'] = bullish > bearish
    ? 'bullish'
    : bearish > bullish
      ? 'bearish'
      : 'mixed'
  const conflicts: string[] = []
  const confluences: string[] = []
  for (let leftIndex = 0; leftIndex < successful.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < successful.length; rightIndex += 1) {
      const left = successful[leftIndex]!
      const right = successful[rightIndex]!
      const leftTrend = left.summary!.trend
      const rightTrend = right.summary!.trend
      if (leftTrend === 'unknown' || rightTrend === 'unknown') continue
      if (leftTrend === rightTrend) {
        confluences.push(`${left.interval} and ${right.interval} trend both ${leftTrend}`)
      } else {
        conflicts.push(`${left.interval} trend ${leftTrend} conflicts with ${right.interval} trend ${rightTrend}`)
      }
    }
  }
  for (const interval of successful) {
    if (interval.summary!.confluenceZoneCount > 0) {
      confluences.push(`${interval.interval} has ${interval.summary!.confluenceZoneCount} EMA/VWAP/Fibonacci confluence zone(s)`)
    }
  }
  const distinctTrends = new Set(successful.map((entry) => entry.summary!.trend).filter((trend) => trend !== 'unknown'))
  const alignment: TechnicalAnalysisSummary['alignment'] = conflicts.length > 0
    ? 'conflicted'
    : distinctTrends.size === 1 && successful.length > 1
      ? 'aligned'
      : successful.length > 1
        ? 'mixed'
        : 'unknown'

  return {
    bias,
    alignment,
    conflicts,
    confluences,
    warnings: intervals.flatMap((entry) => entry.summary?.warnings ?? []),
  }
}

export async function analyzeTechnicalAnalysis(
  barService: BarService,
  params: AnalyzeTechnicalAnalysisParams,
): Promise<TechnicalAnalysisResult> {
  const mode = params.mode ?? 'context'
  const intervals = [...new Set(
    params.intervals?.length ? params.intervals : params.interval ? [params.interval] : [],
  )]
  if (intervals.length === 0) {
    return {
      status: 'error',
      summary: {
        bias: 'unknown',
        alignment: 'unknown',
        conflicts: [],
        confluences: [],
        warnings: ['At least one interval is required for technical analysis'],
      },
      intervals: [],
    }
  }

  const results: TechnicalAnalysisIntervalResult[] = []
  for (const interval of intervals) {
    results.push(await analyzeTechnicalAnalysisInterval(barService, params, interval, mode))
  }
  const status: TechnicalAnalysisResult['status'] = results.every((entry) => entry.status === 'ok')
    ? 'ok'
    : results.every((entry) => entry.status === 'error')
      ? 'error'
      : results.some((entry) => entry.status === 'ok')
        ? 'partial'
        : 'insufficient'
  return {
    status,
    summary: summarizeIntervals(results),
    intervals: results,
  }
}
