import { describe, expect, it } from 'vitest'
import type { OrderFlowDeltaBar } from './context.js'
import { toSignedVolumeEvidence } from './volume-evidence.js'

describe('toSignedVolumeEvidence', () => {
  it('projects reusable signed-volume evidence without leaking bar fields', () => {
    const bar: OrderFlowDeltaBar = {
      date: '2024-01-01',
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1_000,
      delta: 250,
      cvd: 250,
      deltaRatio: 0.25,
      coverage: 0.95,
      confidence: 'high',
      lowConfidence: false,
      isApproximation: true,
    }

    expect(toSignedVolumeEvidence(bar, '1m', 15)).toEqual({
      delta: 250,
      deltaRatio: 0.25,
      coverage: 0.95,
      confidence: 'high',
      intrabarInterval: '1m',
      intrabarCount: 15,
    })
  })
})
