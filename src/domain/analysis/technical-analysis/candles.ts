import type {
  AccumulationDistributionZone,
  BalancePriceRange,
  ConfluenceZone,
  EqualHighLow,
  FairValueGap,
  FibRetracement,
  LiquidityZone,
  NormalizedTechnicalAnalysisOptions,
  NormalizedTechnicalAnalysisBprOptions,
  NormalizedTechnicalAnalysisConfluenceZoneOptions,
  NormalizedTechnicalAnalysisFibOptions,
  NormalizedTechnicalAnalysisLiquidityOptions,
  NormalizedTechnicalAnalysisLimitsOptions,
  NormalizedTechnicalAnalysisStopZoneOptions,
  NormalizedTechnicalAnalysisUnusualVolumeOptions,
  NormalizedTechnicalAnalysisVolumeProfileOptions,
  NormalizedTechnicalAnalysisVwapDeviationOptions,
  NormalizedTechnicalAnalysisZoneFilterOptions,
  OrderBlock,
  PivotLevel,
  PremiumDiscountZone,
  PricePivot,
  StopZone,
  StrongWeakLevel,
  StructureEvent,
  TechnicalAnalysisAnalysis,
  TechnicalAnalysisCandle,
  TechnicalAnalysisConfluence,
  TechnicalAnalysisDirection,
  TechnicalAnalysisOptions,
  TechnicalAnalysisRelevance,
  TechnicalAnalysisRelevantZone,
  VolumePriceSignal,
  VolumeProfileSnapshot,
  VwapDeviationContext,
} from './types.js'

import { compareTime } from './helpers.js'
import { emptyRelevance } from './relevance.js'

export function emptyAnalysis(warnings: string[]): TechnicalAnalysisAnalysis {
  return {
    summary: {
      candles: 0,
      trend: 'neutral',
      internalTrend: 'neutral',
      swingTrend: 'neutral',
      structureEvents: 0,
      orderBlocks: 0,
      fairValueGaps: 0,
      liquidityZones: 0,
      balancePriceRanges: 0,
      fibRetracements: 0,
      confluenceZones: 0,
      volumeProfiles: 0,
      stopZones: 0,
      unusualVolumeSignals: 0,
      vwapDeviationSignals: 0,
      ifvgZones: 0,
      equalHighLows: 0,
      accumulationDistributionZones: 0,
      warnings,
    },
    pivots: [],
    structureEvents: [],
    orderBlocks: [],
    fairValueGaps: [],
    liquidityZones: [],
    balancePriceRanges: [],
    fibRetracements: [],
    confluenceZones: [],
    volumeProfiles: [],
    stopZones: [],
    equalHighLows: [],
    accumulationDistributionZones: [],
    strongWeakLevels: [],
    volumePriceSignals: [],
    relevance: emptyRelevance(),
    warnings,
  }
}

export function normalizeCandles(raw: TechnicalAnalysisCandle[], warnings: string[]): TechnicalAnalysisCandle[] {
  const valid = raw.filter((candle) =>
    Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && candle.high >= candle.low)

  if (valid.length !== raw.length) warnings.push(`${raw.length - valid.length} invalid candles were ignored.`)

  const sorted = [...valid].sort((a, b) => compareTime(a.time, b.time))
  if (valid.some((candle, index) => sorted[index] !== candle)) {
    warnings.push('Candles were sorted by time before analysis.')
  }
  return sorted
}
