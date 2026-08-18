import type { OhlcvBar } from '@/domain/market-data/bars/index.js'
import type { OrderFlowDeltaBar, OrderFlowProfileContext } from './context.js'
import { detectAbsorptionCandidates, type AbsorptionAnalysis } from './absorption.js'
import { buildOrderFlowDivergence, type OrderFlowDivergenceSummary } from './divergence.js'
import { detectExhaustionCandidates, type ExhaustionAnalysis } from './exhaustion.js'
import { buildProfileStructure, type ProfileStructure } from './profile-structure.js'

export type OrderFlowFidelity = 'bar_proxy'
export type OrderFlowDirection = 'positive' | 'negative' | 'neutral'
export type OrderFlowTendency = 'rising' | 'falling' | 'flat'
export type ProfilePriceRelation = 'above' | 'inside' | 'below'
export type SummaryUnavailableReason =
  | 'missing_target_bars'
  | 'missing_intrabars'
  | 'missing_volume'
  | 'insufficient_samples'
  | 'insufficient_confirmed_pivots'
  | 'insufficient_coverage'
  | 'degraded_data'

export interface SummaryComponentReliability {
  status: 'full' | 'degraded' | 'unavailable'
  inputWindowTruncated: boolean
  degradationReason?: string
}

export interface UnavailableSummaryComponent {
  status: 'unavailable'
  reason: SummaryUnavailableReason
  sampleCount: number
  reliability: SummaryComponentReliability
}

export interface CurrentDeltaState {
  status: 'available'
  direction: OrderFlowDirection
  normalizedStrength: number
  delta: number
  cvd: number
  cvdDirection: OrderFlowDirection
  recentCvdTendency: OrderFlowTendency
  recentCvdChange: number
  /** CVD change over the reported recent lookback, independent of the window anchor. */
  cvdChangeOverN: number
  cvdChangeLookback: number
  sampleCount: number
  coverage: number
  confidence: OrderFlowDeltaBar['confidence']
  reliability: SummaryComponentReliability
}

export interface CurrentProfileState {
  status: 'available'
  close: number
  poc: number
  distanceFromPoc: number
  pocRelation: ProfilePriceRelation
  valueArea: {
    high: number
    low: number
    location: ProfilePriceRelation
    distanceToValueArea: number
  }
  sampleCount: number
  reliability: SummaryComponentReliability
}

export interface OrderFlowStructureSummary {
  fidelity: OrderFlowFidelity
  isApproximation: true
  currentState: {
    bar: {
      index: number
      sourceIndex: number
      timestamp: string
      close: number
      barCompletion: 'unknown'
    } | null
    delta: CurrentDeltaState | UnavailableSummaryComponent
    profile: CurrentProfileState | UnavailableSummaryComponent
  }
  profileStructure: ProfileStructure
  divergence: OrderFlowDivergenceSummary
  absorption: AbsorptionAnalysis
  exhaustion: ExhaustionAnalysis
  methods: {
    delta: 'lower_timeframe_ohlcv_signed_volume'
    deltaStrength: 'absolute_delta_ratio'
    cvdTendency: 'endpoint_change'
    cvdTendencyLookback: number
    profileLocation: 'latest_close_vs_window_profile'
  }
  window: {
    targetBarCount: number
    intrabarCount: number
    targetIndexOffset: number
  }
}

const CVD_TENDENCY_LOOKBACK = 5

function direction(value: number): OrderFlowDirection {
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

function tendency(value: number): OrderFlowTendency {
  if (value > 0) return 'rising'
  if (value < 0) return 'falling'
  return 'flat'
}

function relationToRange(value: number, low: number, high: number): ProfilePriceRelation {
  if (value < low) return 'below'
  if (value > high) return 'above'
  return 'inside'
}

function distanceToRange(value: number, low: number, high: number): number {
  if (value < low) return value - low
  if (value > high) return value - high
  return 0
}

function unavailable(
  reason: SummaryUnavailableReason,
  sampleCount: number,
  reliability: SummaryComponentReliability,
): UnavailableSummaryComponent {
  return { status: 'unavailable', reason, sampleCount, reliability: { ...reliability, status: 'unavailable' } }
}

export function buildOrderFlowStructureSummary(params: {
  targetBars: OhlcvBar[]
  deltaBars: OrderFlowDeltaBar[]
  profile: OrderFlowProfileContext | null
  intrabarCount: number
  targetIndexOffset: number
  targetInterval: string
  unavailableReason?: 'missing_target_bars' | 'missing_intrabars' | 'missing_volume'
  degradationReason?: string
  inputWindowTruncated?: boolean
}): OrderFlowStructureSummary {
  const inputWindowTruncated = params.inputWindowTruncated ?? false
  const componentReliability: SummaryComponentReliability = {
    status: params.unavailableReason ? 'unavailable' : params.degradationReason ? 'degraded' : 'full',
    inputWindowTruncated,
    ...(params.degradationReason ? { degradationReason: params.degradationReason } : {}),
  }
  const latestIndex = params.targetBars.length - 1
  const latestBar = params.targetBars[latestIndex]
  const latestDelta = params.deltaBars[latestIndex]
  // A change over N bars needs N+1 CVD samples (the endpoint and N deltas).
  const cvdWindow = params.deltaBars.slice(-(CVD_TENDENCY_LOOKBACK + 1))
  const recentCvdChange = cvdWindow.length > 1
    ? cvdWindow[cvdWindow.length - 1]!.cvd - cvdWindow[0]!.cvd
    : 0
  const cvdChangeOverN = recentCvdChange

  const delta = latestDelta
    ? {
      status: 'available' as const,
      direction: direction(latestDelta.delta),
      normalizedStrength: Math.abs(latestDelta.deltaRatio),
      delta: latestDelta.delta,
      cvd: latestDelta.cvd,
      cvdDirection: direction(latestDelta.cvd),
      recentCvdTendency: tendency(recentCvdChange),
      recentCvdChange,
      cvdChangeOverN,
      cvdChangeLookback: Math.max(0, cvdWindow.length - 1),
      sampleCount: cvdWindow.length,
      coverage: latestDelta.coverage,
      confidence: latestDelta.confidence,
      reliability: componentReliability,
    }
    : unavailable(params.unavailableReason ?? 'insufficient_samples', params.deltaBars.length, componentReliability)

  const profile = latestBar && params.profile?.poc && params.profile.valueArea && params.profile.bins.length > 0
    ? (() => {
      const poc = (params.profile.poc.priceLow + params.profile.poc.priceHigh) / 2
      return {
        status: 'available' as const,
        close: latestBar.close,
        poc,
        distanceFromPoc: latestBar.close - poc,
        pocRelation: relationToRange(latestBar.close, params.profile.poc.priceLow, params.profile.poc.priceHigh),
        valueArea: {
          high: params.profile.valueArea.high,
          low: params.profile.valueArea.low,
          location: relationToRange(latestBar.close, params.profile.valueArea.low, params.profile.valueArea.high),
          distanceToValueArea: distanceToRange(
            latestBar.close,
            params.profile.valueArea.low,
            params.profile.valueArea.high,
          ),
        },
        sampleCount: params.intrabarCount,
        reliability: componentReliability,
      }
    })()
    : unavailable(params.unavailableReason ?? 'insufficient_samples', params.intrabarCount, componentReliability)
  const profileStructure = buildProfileStructure(
    params.profile?.bins ?? null,
    params.unavailableReason,
    componentReliability,
  )
  const divergence = buildOrderFlowDivergence({
    targetBars: params.targetBars,
    deltaBars: params.deltaBars,
    targetIndexOffset: params.targetIndexOffset,
    unavailableReason: params.unavailableReason,
    ...(params.degradationReason ? { degradationReason: params.degradationReason } : {}),
    reliability: componentReliability,
  })
  const absorption = detectAbsorptionCandidates({
    targetBars: params.targetBars,
    deltaBars: params.deltaBars,
    targetIndexOffset: params.targetIndexOffset,
    unavailableReason: params.unavailableReason,
    ...(params.degradationReason ? { degradationReason: params.degradationReason } : {}),
    reliability: componentReliability,
  })
  const exhaustion = detectExhaustionCandidates({
    targetBars: params.targetBars,
    deltaBars: params.deltaBars,
    targetIndexOffset: params.targetIndexOffset,
    unavailableReason: params.unavailableReason,
    ...(params.degradationReason ? { degradationReason: params.degradationReason } : {}),
    reliability: componentReliability,
  })

  return {
    fidelity: 'bar_proxy',
    isApproximation: true,
    currentState: {
      bar: latestBar
        ? {
          index: latestIndex,
          sourceIndex: params.targetIndexOffset + latestIndex,
          timestamp: latestBar.date,
          close: latestBar.close,
          barCompletion: 'unknown',
        }
        : null,
      delta,
      profile,
    },
    profileStructure,
    divergence,
    absorption,
    exhaustion,
    methods: {
      delta: 'lower_timeframe_ohlcv_signed_volume',
      deltaStrength: 'absolute_delta_ratio',
      cvdTendency: 'endpoint_change',
      cvdTendencyLookback: CVD_TENDENCY_LOOKBACK,
      profileLocation: 'latest_close_vs_window_profile',
    },
    window: {
      targetBarCount: params.targetBars.length,
      intrabarCount: params.intrabarCount,
      targetIndexOffset: params.targetIndexOffset,
    },
  }
}
