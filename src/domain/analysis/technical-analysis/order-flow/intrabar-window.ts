import { type BarMeta, type BarService, type BarSourceRef, type BarsResult, type GetBarsOpts, type OhlcvBar } from '@/domain/market-data/bars/index.js'
import { errorMessage } from '../shared.js'
import { chooseIntrabarPlan, type IntrabarPlan } from './intrabar-plan.js'
import { intervalToMinutesOrDefault, parseBarDateUTC } from './interval-time.js'

export type IntrabarWindowStatus = 'available' | 'no_target_bars' | 'no_intrabars'

export interface IntrabarWindowResult {
  status: IntrabarWindowStatus
  plan: IntrabarPlan
  targetBars: OhlcvBar[]
  intrabars: OhlcvBar[]
  targetMeta?: BarMeta
  targetIndexOffset: number
}

export async function loadIntrabarWindow(params: {
  barService: BarService
  ref: BarSourceRef
  targetInterval: string
  requestedCount: number
  start?: string
  end?: string
  targetBars?: OhlcvBar[]
  targetMeta?: BarMeta
}): Promise<IntrabarWindowResult> {
  const sourceCapabilities = params.targetMeta?.supportedIntervals
    ? params.targetMeta
    : await params.barService.getSourceCapabilities?.(params.ref)
  const plan = chooseIntrabarPlan(
    params.targetInterval,
    params.requestedCount,
    sourceCapabilities?.supportedIntervals,
  )
  const loaded = await loadTargetBars(params, plan)

  if (loaded.bars.length === 0) {
    return {
      status: 'no_target_bars',
      plan,
      targetBars: [],
      intrabars: [],
      targetMeta: loaded.meta,
      targetIndexOffset: loaded.indexOffset,
    }
  }
  if (plan.intrabarInterval === 'unavailable') {
    return {
      status: 'no_intrabars',
      plan,
      targetBars: loaded.bars,
      intrabars: [],
      targetMeta: loaded.meta,
      targetIndexOffset: loaded.indexOffset,
    }
  }

  const firstBar = loaded.bars[0]!
  const lastBar = loaded.bars[loaded.bars.length - 1]!
  let intrabarResult: BarsResult
  try {
    intrabarResult = await params.barService.getBars(params.ref, {
      interval: plan.intrabarInterval,
      start: firstBar.date.slice(0, 10),
      // Upper bound is the day AFTER the last target bar. Compatibility vendors
      // and TradingView read `end` as an inclusive calendar day, but a broker
      // (UTA) source converts it to a midnight-UTC timestamp — a same-day `end`
      // silently drops every intrabar of the final session there. The next day
      // covers the last session on all three; the timestamp filter below trims
      // the over-fetch.
      end: nextDayUTC(lastBar.date),
    })
  } catch (error) {
    // Order flow is an enrichment, not a precondition. A failed lower-timeframe
    // fetch (socket timeout, unsupported interval upstream) must degrade to the
    // documented no_intrabars path instead of discarding the target-interval
    // analysis the caller already loaded.
    return {
      status: 'no_intrabars',
      plan: withDegradationReason(
        plan,
        `Intrabar (${plan.intrabarInterval}) fetch failed: ${errorMessage(error)}`,
      ),
      targetBars: loaded.bars,
      intrabars: [],
      targetMeta: loaded.meta,
      targetIndexOffset: loaded.indexOffset,
    }
  }
  const start = parseBarDateUTC(firstBar.date).getTime()
  const end = parseBarDateUTC(lastBar.date).getTime() + intervalToMinutesOrDefault(params.targetInterval, 60) * 60_000
  const intrabars = intrabarResult.bars.filter((bar) => {
    const time = parseBarDateUTC(bar.date).getTime()
    return time >= start && time < end
  })

  return {
    status: intrabars.length === 0 ? 'no_intrabars' : 'available',
    plan,
    targetBars: loaded.bars,
    intrabars,
    targetMeta: loaded.meta,
    targetIndexOffset: loaded.indexOffset,
  }
}

/** Calendar day after `date`, in UTC. Date-only so every bar source accepts it. */
function nextDayUTC(date: string): string {
  return new Date(parseBarDateUTC(date.slice(0, 10)).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10)
}

function withDegradationReason(plan: IntrabarPlan, reason: string): IntrabarPlan {
  return {
    ...plan,
    degradationReason: plan.degradationReason ? `${plan.degradationReason} ${reason}` : reason,
  }
}

async function loadTargetBars(
  params: {
    barService: BarService
    ref: BarSourceRef
    targetInterval: string
    requestedCount: number
    start?: string
    end?: string
    targetBars?: OhlcvBar[]
    targetMeta?: BarMeta
  },
  plan: IntrabarPlan,
): Promise<{ bars: OhlcvBar[]; meta?: BarMeta; indexOffset: number }> {
  if (params.targetBars) {
    const bars = params.targetBars.slice(-plan.actualCount)
    return {
      bars,
      meta: params.targetMeta,
      indexOffset: params.targetBars.length - bars.length,
    }
  }

  const opts: GetBarsOpts = {
    interval: params.targetInterval,
    count: plan.actualCount,
    start: params.start,
    end: params.end,
  }
  const targetResult = await params.barService.getBars(params.ref, opts)
  return {
    bars: targetResult.bars,
    meta: targetResult.meta,
    indexOffset: 0,
  }
}
