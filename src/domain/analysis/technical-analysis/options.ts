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

import { clampInt, clampNumber, nonNegativeNumber, positiveNumber, round } from './helpers.js'

export function normalizeOptions(options: TechnicalAnalysisOptions = {}): NormalizedTechnicalAnalysisOptions {
  const emaPeriods = [clampInt(options.emaFastPeriod, 2, 500, 12), clampInt(options.emaSlowPeriod, 2, 500, 20), clampInt(options.emaLongPeriod, 2, 500, 50)]
    .sort((a, b) => a - b)
  return {
    internalLookback: clampInt(options.internalLookback, 2, 100, 5),
    swingLookback: clampInt(options.swingLookback, 2, 250, 50),
    useCloseBreak: options.useCloseBreak ?? true,
    zoneMode: options.zoneMode ?? 'Fast',
    fvgMode: options.fvgMode ?? 'FVG',
    obFilter: options.obFilter ?? 'None',
    obMitigation: options.obMitigation ?? 'Absolute',
    obPosition: options.obPosition ?? 'Precise',
    volumeLookback: clampInt(options.volumeLookback, 2, 250, 20),
    emaFastPeriod: emaPeriods[0],
    emaSlowPeriod: emaPeriods[1],
    emaLongPeriod: emaPeriods[2],
    vwapEnabled: options.vwapEnabled ?? true,
    vwapAnchor: options.vwapAnchor ?? 'auto',
    fib: normalizeFibOptions(options.fib),
    confluenceZone: normalizeConfluenceZoneOptions(options.confluenceZone),
    volumeProfile: normalizeVolumeProfileOptions(options.volumeProfile),
    unusualVolume: normalizeUnusualVolumeOptions(options.unusualVolume),
    stopZone: normalizeStopZoneOptions(options.stopZone),
    vwapDeviation: normalizeVwapDeviationOptions(options.vwapDeviation),
    atrPeriod: clampInt(options.atrPeriod, 2, 500, 200),
    equalToleranceAtr: typeof options.equalToleranceAtr === 'number' && Number.isFinite(options.equalToleranceAtr)
      ? Math.max(0, options.equalToleranceAtr)
      : 0.1,
    maxOrderBlocks: clampInt(options.maxOrderBlocks, 1, 100, 10),
    liquidity: normalizeLiquidityOptions(options.liquidity),
    bpr: normalizeBprOptions(options.bpr),
    limits: normalizeLimitOptions(options.limits),
    zoneFilter: normalizeZoneFilterOptions(options.zoneFilter),
  }
}

export function normalizeFibOptions(options: TechnicalAnalysisOptions['fib'] = {}): NormalizedTechnicalAnalysisFibOptions {
  const defaultLevels = [0.382, 0.5, 0.618, 0.786]
  const levels = (options.levels ?? defaultLevels)
    .filter((value) => Number.isFinite(value) && value > 0 && value < 1)
    .map((value) => round(value, 4))
    .sort((a, b) => a - b)
  return {
    enabled: options.enabled ?? true,
    anchorMode: 'structure-leg',
    levels: levels.length > 0 ? levels : defaultLevels,
  }
}

export function normalizeConfluenceZoneOptions(options: TechnicalAnalysisOptions['confluenceZone'] = {}): NormalizedTechnicalAnalysisConfluenceZoneOptions {
  return {
    enabled: options.enabled ?? true,
    minFamilies: clampInt(options.minFamilies, 2, 3, 2),
    overlapAtrMultiplier: positiveNumber(options.overlapAtrMultiplier, 0.25),
    maxVisible: clampInt(options.maxVisible, 1, 200, 8),
  }
}

export function normalizeVolumeProfileOptions(options: TechnicalAnalysisOptions['volumeProfile'] = {}): NormalizedTechnicalAnalysisVolumeProfileOptions {
  return {
    enabled: options.enabled ?? true,
    mode: options.mode ?? 'rolling',
    lookback: clampInt(options.lookback, 20, 2000, 300),
    bins: clampInt(options.bins, 20, 400, 150),
    valueAreaPercent: clampNumber(options.valueAreaPercent, 1, 100, 70),
    smoothing: clampInt(options.smoothing, 0, 20, 3),
    voidThresholdRatio: positiveNumber(options.voidThresholdRatio, 0.15),
  }
}

export function normalizeUnusualVolumeOptions(options: TechnicalAnalysisOptions['unusualVolume'] = {}): NormalizedTechnicalAnalysisUnusualVolumeOptions {
  return {
    enabled: options.enabled ?? true,
    baselineLookback: clampInt(options.baselineLookback, 20, 1000, 200),
    zScoreThreshold: positiveNumber(options.zScoreThreshold, 2),
    rvolThreshold: positiveNumber(options.rvolThreshold, 1.5),
  }
}

export function normalizeStopZoneOptions(options: TechnicalAnalysisOptions['stopZone'] = {}): NormalizedTechnicalAnalysisStopZoneOptions {
  return {
    enabled: options.enabled ?? true,
    pivotLookback: clampInt(options.pivotLookback, 2, 250, 50),
    maxActive: clampInt(options.maxActive, 1, 100, 10),
    volumeMultiplier: positiveNumber(options.volumeMultiplier, 1.2),
  }
}

export function normalizeVwapDeviationOptions(options: TechnicalAnalysisOptions['vwapDeviation'] = {}): NormalizedTechnicalAnalysisVwapDeviationOptions {
  return {
    enabled: options.enabled ?? true,
    stdDevMultiplier: positiveNumber(options.stdDevMultiplier, 2),
    bandLookback: clampInt(options.bandLookback, 5, 1000, 50),
    signalEnabled: options.signalEnabled ?? true,
  }
}

export function normalizeLiquidityOptions(options: TechnicalAnalysisOptions['liquidity'] = {}): NormalizedTechnicalAnalysisLiquidityOptions {
  return {
    enabled: options.enabled ?? true,
    atrMargin: positiveNumber(options.atrMargin, 2.5),
    minClusterSize: clampInt(options.minClusterSize, 2, 20, 3),
    maxVisible: clampInt(options.maxVisible, 1, 200, 12),
  }
}

export function normalizeBprOptions(options: TechnicalAnalysisOptions['bpr'] = {}): NormalizedTechnicalAnalysisBprOptions {
  return {
    enabled: options.enabled ?? true,
    maxVisible: clampInt(options.maxVisible, 1, 100, 8),
  }
}

export function normalizeLimitOptions(options: TechnicalAnalysisOptions['limits'] = {}): NormalizedTechnicalAnalysisLimitsOptions {
  return {
    maxStructureEvents: clampInt(options.maxStructureEvents, 20, 5000, 600),
    maxOrderBlocks: clampInt(options.maxOrderBlocks, 5, 500, 120),
    maxFairValueGaps: clampInt(options.maxFairValueGaps, 5, 1000, 240),
    maxLiquidityZones: clampInt(options.maxLiquidityZones, 5, 500, 120),
    maxBalancePriceRanges: clampInt(options.maxBalancePriceRanges, 5, 500, 120),
    maxVolumeSignals: clampInt(options.maxVolumeSignals, 20, 5000, 800),
  }
}

export function normalizeZoneFilterOptions(options: TechnicalAnalysisOptions['zoneFilter'] = {}): NormalizedTechnicalAnalysisZoneFilterOptions {
  return {
    enabled: options.enabled ?? true,
    includeMitigatedOrderBlocks: options.includeMitigatedOrderBlocks ?? false,
    includeInvalidatedOrderBlocks: options.includeInvalidatedOrderBlocks ?? false,
    includeFilledFairValueGaps: options.includeFilledFairValueGaps ?? false,
    maxAgeBars: clampInt(options.maxAgeBars, 1, 10000, 160),
    maxDistanceAtr: positiveNumber(options.maxDistanceAtr, 4),
    minGapAtr: nonNegativeNumber(options.minGapAtr, 0.1),
    minGapPercent: nonNegativeNumber(options.minGapPercent, 0.0003),
    maxZones: clampInt(options.maxZones, 1, 200, 12),
    mergeOverlappingZones: options.mergeOverlappingZones ?? true,
  }
}
