/**
 * Replay specs for the `watch` data-availability gate: closed-bar rule,
 * trading-day staleness, and minute-level staleness. Pure (injected `nowMs`),
 * no network.
 */
import { describe, expect, it } from 'vitest'

import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import { gateWatchFreshness } from './freshness.js'

function bar(date: string, close = 100): OhlcvBar {
  return { date, open: close - 1, high: close + 1, low: close - 1, close, volume: 100 }
}

describe('gateWatchFreshness', () => {
  it('judges on closed bars only (drops the in-progress bar)', () => {
    const bars = [
      bar('2024-01-02 09:00', 100),
      bar('2024-01-02 10:00', 101), // 1h bar ends 11:00Z, still open at 10:30Z
    ]
    const out = gateWatchFreshness({
      bars,
      interval: '1h',
      nowMs: Date.parse('2024-01-02T10:30:00Z'),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.closedBars).toHaveLength(1)
    expect(out.dataAsOf).toBe('2024-01-02 09:00')
  })

  it('is unavailable when every bar is still in progress', () => {
    const out = gateWatchFreshness({
      bars: [bar('2024-01-02 10:00', 101)],
      interval: '1h',
      nowMs: Date.parse('2024-01-02T10:30:00Z'),
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toMatch(/still in progress/)
  })

  it('rejects trading-day-stale data beyond the policy', () => {
    const out = gateWatchFreshness({
      bars: [bar('2024-01-01', 100)],
      interval: '1d',
      staleTradingDays: 3,
      policy: { maxStaleTradingDays: 0 },
      nowMs: Date.parse('2024-01-08T00:00:00Z'),
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toMatch(/3 trading day\(s\) behind/)
  })

  it('recomputes trading-day freshness after dropping a forming latest bar', () => {
    const out = gateWatchFreshness({
      bars: [
        bar('2024-01-01 09:00', 100),
        bar('2024-01-02 10:00', 101), // still forming at 10:30Z
      ],
      interval: '1h',
      staleTradingDays: 0, // metadata describes the forming Jan 2 row
      anchorDate: '2024-01-02',
      nowMs: Date.parse('2024-01-02T10:30:00Z'),
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toMatch(/1 trading day\(s\) behind/)
  })

  it('enforces the minute-level bound on intraday intervals', () => {
    const bars = [bar('2024-01-02 09:00', 100)] // ends 10:00Z
    const stale = gateWatchFreshness({
      bars,
      interval: '1h',
      policy: { maxStaleMinutes: 30 },
      nowMs: Date.parse('2024-01-02T12:00:00Z'),
    })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.reason).toMatch(/120m ago/)
    const fresh = gateWatchFreshness({
      bars,
      interval: '1h',
      policy: { maxStaleMinutes: 180 },
      nowMs: Date.parse('2024-01-02T12:00:00Z'),
    })
    expect(fresh.ok).toBe(true)
  })

  it('is unavailable on an empty window', () => {
    const out = gateWatchFreshness({ bars: [], interval: '1h', nowMs: 0 })
    expect(out.ok).toBe(false)
  })
})
