import type { OrderFlowDeltaBar } from './context.js'

/** Shared lower-timeframe evidence passed from Order Flow into other detectors. */
export interface SignedVolumeEvidence {
  delta: number
  deltaRatio: number
  coverage: number
  confidence: OrderFlowDeltaBar['confidence']
  intrabarInterval: string
  intrabarCount: number
}

export function toSignedVolumeEvidence(
  bar: OrderFlowDeltaBar,
  intrabarInterval: string,
  intrabarCount: number,
): SignedVolumeEvidence {
  return {
    delta: bar.delta,
    deltaRatio: bar.deltaRatio,
    coverage: bar.coverage,
    confidence: bar.confidence,
    intrabarInterval,
    intrabarCount,
  }
}
