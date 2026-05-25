import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../../canonical-json.js'
import { assertReplayDeterministic, runSignalEngine } from '../../service.js'
import type { ReplayBar, StrategyPlugin } from '../../types.js'
import { structureVolumePriceStrategy } from './index.js'

function bar(index: number, open: number, high: number, low: number, close: number, volume = 1000): ReplayBar {
  return {
    time: `2026-05-08T00:${String(index).padStart(2, '0')}:00.000Z`,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: String(volume),
    closed: true,
  }
}

const bars: ReplayBar[] = [
  bar(0, 10, 11, 9, 10, 1000),
  bar(1, 10, 12, 9, 11, 1050),
  bar(2, 11, 13, 10, 12, 1000),
  bar(3, 12, 13, 11, 12, 950),
  bar(4, 12, 13, 10, 11, 900),
  bar(5, 11, 12, 9, 10, 950),
  bar(6, 10, 11, 9, 10, 1000),
  bar(7, 10, 15, 10, 15, 2200),
]

const baseInput = {
  asset: 'equity' as const,
  symbol: 'QQQ',
  interval: '5m',
  provider: 'fixture',
  strategy: structureVolumePriceStrategy,
  riskTemplate: { id: 'default-risk', version: '1', totalQuantity: '1', stopLossBps: '50' },
  bars,
}

describe('canonicalJson', () => {
  it('sorts object keys and rejects undefined', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "b": 2\n}\n')
    expect(() => canonicalJson({ a: undefined })).toThrow('undefined')
  })
})

describe('runSignalEngine', () => {
  it('passes only prefix history to plugins and derives stable hashes', () => {
    const seenLengths: number[] = []
    const plugin: StrategyPlugin = {
      id: 'probe',
      version: '1',
      evaluate(history) {
        seenLengths.push(history.length)
        return []
      },
    }

    const first = runSignalEngine({ ...baseInput, strategy: plugin, bars: bars.slice(0, 4) })
    const second = runSignalEngine({ ...baseInput, strategy: plugin, bars: bars.slice(0, 4) })

    expect(seenLengths.slice(0, 4)).toEqual([1, 2, 3, 4])
    expect(first.runId).toBe(second.runId)
    expect(first.inputHash).toBe(second.inputHash)
    expect(first.outputHash).toBe(second.outputHash)
  })

  it('rejects incomplete bars', () => {
    expect(() => runSignalEngine({
      ...baseInput,
      bars: [{ ...bars[0], closed: false as true }],
    })).toThrow('not closed')
  })
})

describe('structureVolumePriceStrategy', () => {
  it('emits deterministic LMT signals with stopLoss from closed prefix replay', () => {
    const result = runSignalEngine(baseInput)
    const repeat = runSignalEngine(baseInput)

    expect(assertReplayDeterministic(baseInput)).toBe(true)
    expect(result.signals.length).toBeGreaterThan(0)
    expect(result.signals[0]).toMatchObject({
      kind: 'structure_volume_price',
      order: expect.objectContaining({
        orderType: 'LMT',
        stopLoss: expect.objectContaining({ price: expect.any(String) }),
      }),
    })
    expect(result).toEqual(repeat)
  })
})
