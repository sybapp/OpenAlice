/**
 * Data-availability gate for `watch` checks (increment 1).
 *
 * The bar layer's freshness contract is trading-day based (`staleTradingDays`
 * on `BarMeta`); monitors also need a minute-level answer for intraday
 * intervals plus a closed-bar rule. This module is pure (takes `nowMs`) so
 * the gate is replayable in specs:
 *
 * - `closed_bar` quote: the last bar must END at or before `now` — a bar
 *   still in progress is usable history but never the judgement bar.
 * - `maxStaleTradingDays` (default 0): trading-day gap between the last
 *   CLOSED bar and the anchor must not exceed it.
 * - `maxStaleMinutes` (intraday intervals only): wall-clock gap between the
 *   last closed bar end and `now` must not exceed it. Omission means no
 *   minute-level bound (daily/weekly bars have no intraday expectation).
 */

import { intervalToMinutes, parseBarDateUTC } from '../order-flow/interval-time.js'
import type { OhlcvBar } from '@/domain/market-data/bars/types.js'

export interface WatchFreshnessPolicy {
  maxStaleTradingDays?: number
  maxStaleMinutes?: number
}

export interface WatchFreshnessInput {
  bars: readonly OhlcvBar[]
  interval: string
  policy?: WatchFreshnessPolicy
  /** Trading-day gap from the bar layer (`BarMeta.staleTradingDays`). */
  staleTradingDays?: number
  nowMs: number
}

export type WatchFreshnessVerdict =
  | { ok: true; closedBars: OhlcvBar[]; dataAsOf: string }
  | { ok: false; reason: string }

function barEndMs(bar: OhlcvBar, intervalMinutes: number | null): number | null {
  const start = parseBarDateUTC(bar.date).getTime()
  if (!Number.isFinite(start) || intervalMinutes === null) return null
  return start + intervalMinutes * 60_000
}

export function gateWatchFreshness(input: WatchFreshnessInput): WatchFreshnessVerdict {
  const { bars, interval, nowMs } = input
  if (bars.length === 0) {
    return { ok: false, reason: 'no bars returned for the requested window' }
  }
  const intervalMinutes = intervalToMinutes(interval)
  let closedBars: OhlcvBar[] = [...bars]
  if (intervalMinutes !== null) {
    closedBars = bars.filter((bar) => {
      const end = barEndMs(bar, intervalMinutes)
      return end !== null && end <= nowMs
    })
    if (closedBars.length === 0) {
      return {
        ok: false,
        reason: `latest ${interval} bar is still in progress; waiting for its close before judging`,
      }
    }
  }
  const last = closedBars.at(-1)!
  const staleDays = input.staleTradingDays ?? 0
  const maxDays = input.policy?.maxStaleTradingDays ?? 0
  if (staleDays > maxDays) {
    return {
      ok: false,
      reason: `bars are ${staleDays} trading day(s) behind the anchor (max ${maxDays})`,
    }
  }
  const maxMinutes = input.policy?.maxStaleMinutes
  if (maxMinutes !== undefined && intervalMinutes !== null) {
    const end = barEndMs(last, intervalMinutes)
    if (end !== null) {
      const gapMinutes = (nowMs - end) / 60_000
      if (gapMinutes > maxMinutes) {
        return {
          ok: false,
          reason: `last closed ${interval} bar ended ${Math.floor(gapMinutes)}m ago (max ${maxMinutes}m); data is stale`,
        }
      }
    }
  }
  return { ok: true, closedBars, dataAsOf: last.date }
}
