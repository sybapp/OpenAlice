import type { OhlcvBar } from '@/domain/market-data/bars/index.js'
import type { OrderFlowDeltaBar } from './context.js'
import type { SummaryUnavailableReason } from './summary.js'
import type { SummaryComponentReliability } from './summary.js'

export interface OrderFlowCandidateContext {
  targetBars: OhlcvBar[]
  deltaBars: OrderFlowDeltaBar[]
  targetIndexOffset: number
  unavailableReason?: SummaryUnavailableReason
  degradationReason?: string
  reliability?: SummaryComponentReliability
}

export type CandidateContextReadiness =
  | { status: 'ready'; sampleCount: number }
  | { status: 'unavailable'; reason: SummaryUnavailableReason; sampleCount: number }

/** Shared structural checks; detector-specific evidence gates stay local. */
export function candidateContextReadiness(
  params: OrderFlowCandidateContext,
  minimumSamples: number,
): CandidateContextReadiness {
  if (params.unavailableReason) {
    return { status: 'unavailable', reason: params.unavailableReason, sampleCount: params.deltaBars.length }
  }

  const sampleCount = Math.min(params.targetBars.length, params.deltaBars.length)
  if (params.reliability?.inputWindowTruncated) {
    return { status: 'unavailable', reason: 'degraded_data', sampleCount }
  }
  if (params.targetBars.length < minimumSamples
    || params.deltaBars.length < minimumSamples
    || params.targetBars.length !== params.deltaBars.length) {
    return { status: 'unavailable', reason: 'insufficient_samples', sampleCount }
  }

  return { status: 'ready', sampleCount }
}
