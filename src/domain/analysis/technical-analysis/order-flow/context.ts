import type { BarMeta, BarService, OhlcvBar } from '@/domain/market-data/bars/index.js'
import { sourceRef, errorMessage } from '../shared.js'
import {
  calculateDeltaVolume,
  calculateVolumeProfile,
  DEFAULT_PROFILE_BINS,
  type VolumeProfileBin,
} from './delta-volume.js'
import { confidenceForCoverage, chooseIntrabarPlan, type IntrabarPlan } from './intrabar-plan.js'
import { loadIntrabarWindow } from './intrabar-window.js'
import { buildOrderFlowStructureSummary, type OrderFlowStructureSummary } from './summary.js'

export type OrderFlowContextStatus = 'ok' | 'no_target_bars' | 'no_intrabars'

export interface OrderFlowSourceRequest {
  barId: string
  assetClass?: 'equity' | 'crypto' | 'currency' | 'commodity'
}

export interface AnalyzeOrderFlowContextParams extends OrderFlowSourceRequest {
  interval: string
  count?: number
  start?: string
  end?: string
  numBins?: number
  targetBars?: OhlcvBar[]
  targetMeta?: BarMeta
}

export interface OrderFlowDeltaBar extends Omit<OhlcvBar, 'date'> {
  timestamp?: string
  barCompletion?: 'unknown'
  delta: number
  cvd: number
  deltaRatio: number
  coverage: number
  confidence: ReturnType<typeof confidenceForCoverage>
  lowConfidence: boolean
  isApproximation: true
}

export interface OrderFlowMeta extends IntrabarPlan {
  intrabarCount: number
  targetBars: number
  targetIndexOffset: number
  lowConfidenceBars?: number
  isApproximation: true
  /** CVD is reset at this target-bar date; absolute values are window-scoped. */
  cvdAnchorDate?: string
  cvdChangeOverN?: number
  cvdChangeLookback?: number
  [key: string]: unknown
}

export interface OrderFlowDeltaContext {
  bars: OrderFlowDeltaBar[]
}

export interface OrderFlowProfileContext {
  bins: VolumeProfileBin[]
  poc: VolumeProfileBin | null
  valueArea: {
    high: number
    low: number
  } | null
}

export interface OrderFlowContextAnalysis {
  status: OrderFlowContextStatus
  error?: string
  delta?: OrderFlowDeltaContext
  profile?: OrderFlowProfileContext | null
  summary?: OrderFlowStructureSummary
  meta: OrderFlowMeta
}

const DEFAULT_ORDER_FLOW_COUNT = 100

function baseMeta(params: {
  targetMeta?: BarMeta
  plan: IntrabarPlan
  intrabarCount: number
  targetBars: number
  targetIndexOffset: number
  lowConfidenceBars?: number
  cvdAnchorDate?: string
  cvdChangeOverN?: number
  cvdChangeLookback?: number
}): OrderFlowMeta {
  return {
    ...params.targetMeta,
    ...params.plan,
    intrabarCount: params.intrabarCount,
    targetBars: params.targetBars,
    targetIndexOffset: params.targetIndexOffset,
    ...(params.lowConfidenceBars === undefined ? {} : { lowConfidenceBars: params.lowConfidenceBars }),
    isApproximation: true,
    ...(params.cvdAnchorDate ? { cvdAnchorDate: params.cvdAnchorDate } : {}),
    ...(params.cvdChangeOverN === undefined ? {} : { cvdChangeOverN: params.cvdChangeOverN }),
    ...(params.cvdChangeLookback === undefined ? {} : { cvdChangeLookback: params.cvdChangeLookback }),
  }
}

/**
 * Order flow ENRICHES a target-interval read; it is never a precondition for
 * one. Any failure below the window loader (provider outage, a lower timeframe
 * the source refuses, malformed intrabars) degrades to the documented
 * no_intrabars payload so the caller keeps its Price Action, indicators and
 * meta instead of losing the whole interval. The cause stays visible in
 * `error` and in the summary's degradationReason.
 */
export async function analyzeOrderFlowContext(
  barService: BarService,
  params: AnalyzeOrderFlowContextParams,
): Promise<OrderFlowContextAnalysis> {
  try {
    return await runOrderFlowContext(barService, params)
  } catch (error) {
    return degradedOrderFlowContext(params, error)
  }
}

function degradedOrderFlowContext(
  params: AnalyzeOrderFlowContextParams,
  error: unknown,
): OrderFlowContextAnalysis {
  const targetBars = params.targetBars ?? []
  const plan = chooseIntrabarPlan(
    params.interval,
    params.count ?? DEFAULT_ORDER_FLOW_COUNT,
    params.targetMeta?.supportedIntervals,
  )
  const reason = `Order-flow context failed: ${errorMessage(error)}`
  return {
    status: 'no_intrabars',
    error: reason,
    delta: { bars: [] },
    profile: { bins: [], poc: null, valueArea: null },
    summary: buildOrderFlowStructureSummary({
      targetBars,
      deltaBars: [],
      targetInterval: params.interval,
      profile: null,
      intrabarCount: 0,
      targetIndexOffset: 0,
      unavailableReason: 'missing_intrabars',
      inputWindowTruncated: plan.truncated,
      degradationReason: reason,
    }),
    meta: baseMeta({
      targetMeta: params.targetMeta,
      plan,
      intrabarCount: 0,
      targetBars: targetBars.length,
      targetIndexOffset: 0,
    }),
  }
}

async function runOrderFlowContext(
  barService: BarService,
  params: AnalyzeOrderFlowContextParams,
): Promise<OrderFlowContextAnalysis> {
  const ref = sourceRef(params)
  const requestedCount = params.count ?? DEFAULT_ORDER_FLOW_COUNT
  const window = await loadIntrabarWindow({
    barService,
    ref,
    targetInterval: params.interval,
    requestedCount,
    start: params.start,
    end: params.end,
    targetBars: params.targetBars,
    targetMeta: params.targetMeta,
  })

  if (window.status === 'no_target_bars') {
    return {
      status: 'no_target_bars',
      error: 'No target bars returned for the requested window',
      delta: { bars: [] },
      profile: { bins: [], poc: null, valueArea: null },
      summary: buildOrderFlowStructureSummary({
          targetBars: [],
          deltaBars: [],
          targetInterval: params.interval,
          profile: null,
          intrabarCount: 0,
          targetIndexOffset: window.targetIndexOffset,
          unavailableReason: 'missing_target_bars',
          inputWindowTruncated: window.plan.truncated,
          ...(window.plan.degradationReason ? { degradationReason: window.plan.degradationReason } : {}),
      }),
      meta: baseMeta({
        targetMeta: window.targetMeta,
        plan: window.plan,
        intrabarCount: 0,
        targetBars: 0,
        targetIndexOffset: window.targetIndexOffset,
      }),
    }
  }

  if (window.status === 'no_intrabars') {
    return {
      status: 'no_intrabars',
      error: window.plan.degradationReason ?? `No intrabar data (${window.plan.intrabarInterval}) returned for the target window`,
      delta: { bars: [] },
      profile: { bins: [], poc: null, valueArea: null },
      summary: buildOrderFlowStructureSummary({
          targetBars: window.targetBars,
          deltaBars: [],
          targetInterval: params.interval,
          profile: null,
          intrabarCount: 0,
          targetIndexOffset: window.targetIndexOffset,
          unavailableReason: 'missing_intrabars',
          inputWindowTruncated: window.plan.truncated,
          ...(window.plan.degradationReason ? { degradationReason: window.plan.degradationReason } : {}),
      }),
      meta: baseMeta({
        targetMeta: window.targetMeta,
        plan: window.plan,
        intrabarCount: 0,
        targetBars: window.targetBars.length,
        targetIndexOffset: window.targetIndexOffset,
      }),
    }
  }

  const hasVolumeEvidence = window.intrabars.some((bar) => bar.volume != null && bar.volume > 0)
  const delta = hasVolumeEvidence
    ? calculateDeltaVolume({
      targetBars: window.targetBars,
      intrabars: window.intrabars,
      targetInterval: params.interval,
    })
    : undefined
  const profile = hasVolumeEvidence
    ? calculateVolumeProfile({
      bars: window.intrabars,
      numBins: params.numBins ?? DEFAULT_PROFILE_BINS,
    })
    : undefined

  const deltaBars: OrderFlowDeltaBar[] = delta
    ? window.targetBars.map((bar, i) => {
      const { date: _date, ...withoutDate } = bar
      return {
      ...withoutDate,
      timestamp: bar.date,
      barCompletion: 'unknown',
      delta: delta.deltas[i],
      cvd: delta.cumulativeDeltas[i],
      deltaRatio: delta.deltaRatios[i],
      coverage: delta.coverage[i],
      confidence: confidenceForCoverage(delta.coverage[i]),
      lowConfidence: delta.lowConfidenceIndices.includes(i),
      isApproximation: true,
      }
    })
    : []
  const profileContext: OrderFlowProfileContext | null = profile?.bins.length
    ? {
      bins: profile.bins,
      poc: profile.poc,
      valueArea: {
        high: profile.valueAreaHigh,
        low: profile.valueAreaLow,
      },
    }
    : null

  return {
    status: 'ok',
    delta: { bars: deltaBars },
    profile: profileContext ?? undefined,
    summary: buildOrderFlowStructureSummary({
        targetBars: window.targetBars,
        deltaBars,
        targetInterval: params.interval,
        profile: profileContext,
        intrabarCount: window.intrabars.length,
        targetIndexOffset: window.targetIndexOffset,
        ...(!hasVolumeEvidence ? { unavailableReason: 'missing_volume' as const } : {}),
        inputWindowTruncated: window.plan.truncated,
        ...(window.plan.degradationReason ? { degradationReason: window.plan.degradationReason } : {}),
    }),
    meta: baseMeta({
      targetMeta: window.targetMeta,
      plan: window.plan,
      intrabarCount: window.intrabars.length,
      targetBars: window.targetBars.length,
      targetIndexOffset: window.targetIndexOffset,
      lowConfidenceBars: delta?.lowConfidenceIndices.length,
      cvdAnchorDate: window.targetBars[0]?.date,
      cvdChangeOverN: deltaBars.length > 1
        ? deltaBars.at(-1)!.cvd - deltaBars[Math.max(0, deltaBars.length - 6)]!.cvd
        : 0,
      cvdChangeLookback: Math.max(0, Math.min(5, deltaBars.length - 1)),
    }),
  }
}
