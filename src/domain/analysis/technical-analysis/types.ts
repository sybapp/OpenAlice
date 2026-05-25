export interface TechnicalAnalysisCandle {
  time: string | number
  open: number
  high: number
  low: number
  close: number
  volume?: number | null
  vwap?: number | null
}

export type TechnicalAnalysisDirection = 'bullish' | 'bearish'
export type PivotLevel = 'internal' | 'swing'

export interface TechnicalAnalysisOptions {
  internalLookback?: number
  swingLookback?: number
  useCloseBreak?: boolean
  zoneMode?: 'Fast' | 'Slow'
  fvgMode?: 'FVG' | 'VI' | 'OG' | 'IFVG'
  obFilter?: 'None' | 'MSS' | 'BOS'
  obMitigation?: 'Absolute' | 'Middle'
  obPosition?: 'Full' | 'Middle' | 'Accurate' | 'Precise'
  volumeLookback?: number
  emaFastPeriod?: number
  emaSlowPeriod?: number
  emaLongPeriod?: number
  vwapEnabled?: boolean
  vwapAnchor?: 'auto' | 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure'
  fib?: TechnicalAnalysisFibOptions
  confluenceZone?: TechnicalAnalysisConfluenceZoneOptions
  volumeProfile?: TechnicalAnalysisVolumeProfileOptions
  unusualVolume?: TechnicalAnalysisUnusualVolumeOptions
  stopZone?: TechnicalAnalysisStopZoneOptions
  vwapDeviation?: TechnicalAnalysisVwapDeviationOptions
  atrPeriod?: number
  equalToleranceAtr?: number
  maxOrderBlocks?: number
  liquidity?: TechnicalAnalysisLiquidityOptions
  bpr?: TechnicalAnalysisBprOptions
  limits?: TechnicalAnalysisLimitsOptions
  zoneFilter?: TechnicalAnalysisZoneFilterOptions
}

export interface TechnicalAnalysisLiquidityOptions {
  enabled?: boolean
  atrMargin?: number
  minClusterSize?: number
  maxVisible?: number
}

export interface TechnicalAnalysisBprOptions {
  enabled?: boolean
  maxVisible?: number
}

export interface TechnicalAnalysisFibOptions {
  enabled?: boolean
  anchorMode?: 'structure-leg'
  levels?: number[]
}

export interface TechnicalAnalysisConfluenceZoneOptions {
  enabled?: boolean
  minFamilies?: number
  overlapAtrMultiplier?: number
  maxVisible?: number
}

export interface TechnicalAnalysisVolumeProfileOptions {
  enabled?: boolean
  mode?: 'rolling' | 'session'
  lookback?: number
  bins?: number
  valueAreaPercent?: number
  smoothing?: number
  voidThresholdRatio?: number
}

export interface TechnicalAnalysisUnusualVolumeOptions {
  enabled?: boolean
  baselineLookback?: number
  zScoreThreshold?: number
  rvolThreshold?: number
}

export interface TechnicalAnalysisStopZoneOptions {
  enabled?: boolean
  pivotLookback?: number
  maxActive?: number
  volumeMultiplier?: number
}

export interface TechnicalAnalysisVwapDeviationOptions {
  enabled?: boolean
  stdDevMultiplier?: number
  bandLookback?: number
  signalEnabled?: boolean
}

export interface TechnicalAnalysisLimitsOptions {
  maxStructureEvents?: number
  maxOrderBlocks?: number
  maxFairValueGaps?: number
  maxLiquidityZones?: number
  maxBalancePriceRanges?: number
  maxVolumeSignals?: number
}

export interface TechnicalAnalysisZoneFilterOptions {
  enabled?: boolean
  includeMitigatedOrderBlocks?: boolean
  includeInvalidatedOrderBlocks?: boolean
  includeFilledFairValueGaps?: boolean
  maxAgeBars?: number
  maxDistanceAtr?: number
  minGapAtr?: number
  minGapPercent?: number
  maxZones?: number
  mergeOverlappingZones?: boolean
}

export interface NormalizedTechnicalAnalysisOptions {
  internalLookback: number
  swingLookback: number
  useCloseBreak: boolean
  zoneMode: 'Fast' | 'Slow'
  fvgMode: 'FVG' | 'VI' | 'OG' | 'IFVG'
  obFilter: 'None' | 'MSS' | 'BOS'
  obMitigation: 'Absolute' | 'Middle'
  obPosition: 'Full' | 'Middle' | 'Accurate' | 'Precise'
  volumeLookback: number
  emaFastPeriod: number
  emaSlowPeriod: number
  emaLongPeriod: number
  vwapEnabled: boolean
  vwapAnchor: 'auto' | 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure'
  fib: NormalizedTechnicalAnalysisFibOptions
  confluenceZone: NormalizedTechnicalAnalysisConfluenceZoneOptions
  volumeProfile: NormalizedTechnicalAnalysisVolumeProfileOptions
  unusualVolume: NormalizedTechnicalAnalysisUnusualVolumeOptions
  stopZone: NormalizedTechnicalAnalysisStopZoneOptions
  vwapDeviation: NormalizedTechnicalAnalysisVwapDeviationOptions
  atrPeriod: number
  equalToleranceAtr: number
  maxOrderBlocks: number
  liquidity: NormalizedTechnicalAnalysisLiquidityOptions
  bpr: NormalizedTechnicalAnalysisBprOptions
  limits: NormalizedTechnicalAnalysisLimitsOptions
  zoneFilter: NormalizedTechnicalAnalysisZoneFilterOptions
}

export interface TechnicalAnalysisConfluence {
  score: number
  emaFast?: number
  emaSlow?: number
  emaLong?: number
  emaBias: 'bullish' | 'bearish' | 'mixed' | 'unavailable'
  vwap?: number
  vwapAnchor?: 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure'
  vwapRelation: 'above' | 'below' | 'at' | 'unavailable'
}

export interface NormalizedTechnicalAnalysisZoneFilterOptions {
  enabled: boolean
  includeMitigatedOrderBlocks: boolean
  includeInvalidatedOrderBlocks: boolean
  includeFilledFairValueGaps: boolean
  maxAgeBars: number
  maxDistanceAtr: number
  minGapAtr: number
  minGapPercent: number
  maxZones: number
  mergeOverlappingZones: boolean
}

export interface NormalizedTechnicalAnalysisLiquidityOptions {
  enabled: boolean
  atrMargin: number
  minClusterSize: number
  maxVisible: number
}

export interface NormalizedTechnicalAnalysisBprOptions {
  enabled: boolean
  maxVisible: number
}

export interface NormalizedTechnicalAnalysisFibOptions {
  enabled: boolean
  anchorMode: 'structure-leg'
  levels: number[]
}

export interface NormalizedTechnicalAnalysisConfluenceZoneOptions {
  enabled: boolean
  minFamilies: number
  overlapAtrMultiplier: number
  maxVisible: number
}

export interface NormalizedTechnicalAnalysisVolumeProfileOptions {
  enabled: boolean
  mode: 'rolling' | 'session'
  lookback: number
  bins: number
  valueAreaPercent: number
  smoothing: number
  voidThresholdRatio: number
}

export interface NormalizedTechnicalAnalysisUnusualVolumeOptions {
  enabled: boolean
  baselineLookback: number
  zScoreThreshold: number
  rvolThreshold: number
}

export interface NormalizedTechnicalAnalysisStopZoneOptions {
  enabled: boolean
  pivotLookback: number
  maxActive: number
  volumeMultiplier: number
}

export interface NormalizedTechnicalAnalysisVwapDeviationOptions {
  enabled: boolean
  stdDevMultiplier: number
  bandLookback: number
  signalEnabled: boolean
}

export interface NormalizedTechnicalAnalysisLimitsOptions {
  maxStructureEvents: number
  maxOrderBlocks: number
  maxFairValueGaps: number
  maxLiquidityZones: number
  maxBalancePriceRanges: number
  maxVolumeSignals: number
}

export interface PricePivot {
  index: number
  time: string | number
  price: number
  kind: 'high' | 'low'
  level: PivotLevel
}

export interface StructureEvent {
  id: string
  index: number
  time: string | number
  direction: TechnicalAnalysisDirection
  type: 'MSS' | 'BOS'
  level: PivotLevel
  brokenPivot: PricePivot
  breakPrice: number
  close: number
  volume?: number | null
  volumeZScore?: number
  volumeConfirmation: 'confirmed' | 'weak' | 'unavailable'
}

export interface OrderBlock {
  id: string
  direction: TechnicalAnalysisDirection
  level: PivotLevel
  sourceStructureId: string
  sourceStructureType: StructureEvent['type']
  index: number
  time: string | number
  leftIndex: number
  leftTime: string | number
  top: number
  bottom: number
  average: number
  sourceVolume?: number | null
  relativeVolumeShare?: number
  mitigated: boolean
  invalidated: boolean
  status: 'active' | 'breaker' | 'invalidated' | 'retired'
  breakIndex?: number
  breakTime?: string | number
  mitigationIndex?: number
  mitigationTime?: string | number
  volumeConfirmation: 'confirmed' | 'weak' | 'unavailable'
}

export interface FairValueGap {
  id: string
  direction: TechnicalAnalysisDirection
  mode: 'FVG' | 'VI' | 'OG' | 'IFVG'
  index: number
  time: string | number
  leftIndex: number
  leftTime: string | number
  top: number
  bottom: number
  midpoint: number
  filled: boolean
  fillIndex?: number
  fillTime?: string | number
  status: 'active' | 'broken' | 'filled'
  breakIndex?: number
  breakTime?: string | number
  volumeConfirmation: 'confirmed' | 'weak' | 'unavailable'
}

export interface LiquidityZone {
  id: string
  side: 'buyside' | 'sellside'
  direction: TechnicalAnalysisDirection
  index: number
  time: string | number
  sourceIndexes: number[]
  top: number
  bottom: number
  midpoint: number
  status: 'active' | 'partially_swept' | 'swept'
  sweepIndex?: number
  sweepTime?: string | number
}

export interface BalancePriceRange {
  id: string
  direction: TechnicalAnalysisDirection
  index: number
  time: string | number
  top: number
  bottom: number
  midpoint: number
  bullishGapId: string
  bearishGapId: string
  status: 'active' | 'broken'
  breakIndex?: number
  breakTime?: string | number
}

export interface FibRetracementLevel {
  ratio: number
  price: number
  touched: boolean
  crossed: boolean
}

export interface FibRetracement {
  id: string
  direction: TechnicalAnalysisDirection
  index: number
  time: string | number
  startIndex: number
  startTime: string | number
  startPrice: number
  endIndex: number
  endTime: string | number
  endPrice: number
  levels: FibRetracementLevel[]
  status: 'active' | 'broken'
}

export interface ConfluenceZone {
  id: string
  index: number
  time: string | number
  top: number
  bottom: number
  midpoint: number
  families: Array<'ema' | 'vwap' | 'fib'>
  components: string[]
  strength: number
  classification: 'support' | 'resistance' | 'pivot'
  status: 'active'
}

export interface VolumeProfileSnapshot {
  id: string
  index: number
  time: string | number
  mode: 'rolling' | 'session'
  anchorKey: string
  lookback: number
  bins: number
  valueAreaPercent: number
  pocPrice: number
  vah: number
  val: number
  voidTop?: number
  voidBottom?: number
  voidMidpoint?: number
  upperVolume: number
  lowerVolume: number
  upperPercent: number
  lowerPercent: number
  skewRatio: number
}

export interface StopZone {
  id: string
  side: 'upper' | 'lower'
  direction: TechnicalAnalysisDirection
  index: number
  time: string | number
  price: number
  status: 'active' | 'triggered'
  triggerIndex?: number
  triggerTime?: string | number
  triggerScore?: number
}

export interface VwapDeviationContext {
  index: number
  time: string | number
  anchor?: 'rolling' | 'session' | 'week' | 'month' | 'year' | 'structure'
  vwap: number
  upper: number
  lower: number
  sigmaDistance: number
  relation: 'above_upper' | 'below_lower' | 'inside'
}

export interface EqualHighLow {
  id: string
  kind: 'EQH' | 'EQL'
  index: number
  time: string | number
  previousIndex: number
  previousTime: string | number
  price: number
  previousPrice: number
  tolerance: number
}

export interface AccumulationDistributionZone {
  id: string
  type: 'Accumulation' | 'Distribution'
  mode: 'Fast' | 'Slow'
  startIndex: number
  endIndex: number
  startTime: string | number
  endTime: string | number
  top: number
  bottom: number
}

export interface PremiumDiscountZone {
  high: number
  low: number
  premiumTop: number
  premiumBottom: number
  equilibrium: number
  discountTop: number
  discountBottom: number
  fromIndex: number
  toIndex: number
}

export interface StrongWeakLevel {
  kind: 'high' | 'low'
  strength: 'strong' | 'weak'
  index: number
  time: string | number
  price: number
  volume?: number | null
  volumeShare?: number
}

export interface VolumePriceSignal {
  id: string
  index: number
  time: string | number
  kind: 'breakout_confirmation' | 'weak_breakout' | 'ob_retest' | 'fvg_fill' | 'bpr_touch' | 'liquidity_sweep' | 'absorption' | 'vp_level' | 'vwap_deviation' | 'stop_run' | 'unusual_volume' | 'ifvg_inversion'
  direction?: TechnicalAnalysisDirection
  score: number
  confluenceScore?: number
  confluence?: TechnicalAnalysisConfluence
  message: string
}

export interface TechnicalAnalysisRelevantZone {
  kind: 'order_block' | 'fair_value_gap' | 'liquidity' | 'balance_price_range' | 'confluence'
  id: string
  direction: TechnicalAnalysisDirection
  index: number
  time: string | number
  top: number
  bottom: number
  midpoint: number
  distance: number
  distanceAtr: number
  volumeConfirmation: 'confirmed' | 'weak' | 'unavailable'
  level?: PivotLevel
  sourceStructureType?: StructureEvent['type']
  status: 'active' | 'mitigated' | 'invalidated' | 'filled' | 'broken' | 'partially_swept' | 'swept'
  sourceIds?: string[]
}

export interface TechnicalAnalysisFilterBucketSummary {
  raw: number
  kept: number
  filtered: number
  reasons: Record<string, number>
}

export interface TechnicalAnalysisRelevanceSummary {
  orderBlocks: TechnicalAnalysisFilterBucketSummary
  fairValueGaps: TechnicalAnalysisFilterBucketSummary
  liquidityZones: TechnicalAnalysisFilterBucketSummary
  balancePriceRanges: TechnicalAnalysisFilterBucketSummary
  confluenceZones: TechnicalAnalysisFilterBucketSummary
}

export interface TechnicalAnalysisRelevance {
  latestClose?: number
  latestAtr: number
  orderBlocks: OrderBlock[]
  fairValueGaps: FairValueGap[]
  liquidityZones: LiquidityZone[]
  balancePriceRanges: BalancePriceRange[]
  confluenceZones: ConfluenceZone[]
  nearestSupport?: TechnicalAnalysisRelevantZone
  nearestResistance?: TechnicalAnalysisRelevantZone
  zones: TechnicalAnalysisRelevantZone[]
  filteredSummary: TechnicalAnalysisRelevanceSummary
}

export interface TechnicalAnalysisSummary {
  candles: number
  trend: 'bullish' | 'bearish' | 'neutral'
  internalTrend: 'bullish' | 'bearish' | 'neutral'
  swingTrend: 'bullish' | 'bearish' | 'neutral'
  latestClose?: number
  structureEvents: number
  orderBlocks: number
  fairValueGaps: number
  liquidityZones: number
  balancePriceRanges: number
  fibRetracements: number
  confluenceZones: number
  volumeProfiles: number
  stopZones: number
  unusualVolumeSignals: number
  vwapDeviationSignals: number
  ifvgZones: number
  equalHighLows: number
  accumulationDistributionZones: number
  confluence?: TechnicalAnalysisConfluence
  vwapDeviation?: VwapDeviationContext
  warnings: string[]
}

export interface TechnicalAnalysisAnalysis {
  summary: TechnicalAnalysisSummary
  pivots: PricePivot[]
  structureEvents: StructureEvent[]
  orderBlocks: OrderBlock[]
  fairValueGaps: FairValueGap[]
  liquidityZones: LiquidityZone[]
  balancePriceRanges: BalancePriceRange[]
  fibRetracements: FibRetracement[]
  confluenceZones: ConfluenceZone[]
  volumeProfiles: VolumeProfileSnapshot[]
  stopZones: StopZone[]
  equalHighLows: EqualHighLow[]
  accumulationDistributionZones: AccumulationDistributionZone[]
  premiumDiscount?: PremiumDiscountZone
  strongWeakLevels: StrongWeakLevel[]
  vwapDeviation?: VwapDeviationContext
  volumePriceSignals: VolumePriceSignal[]
  relevance: TechnicalAnalysisRelevance
  warnings: string[]
}
