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
  const start = parseBarDateUTC(firstBar.date).getTime()
  const end = parseBarDateUTC(lastBar.date).getTime() + intervalToMinutesOrDefault(params.targetInterval, 60) * 60_000
  let intrabarResult: BarsResult
  try {
    intrabarResult = await params.barService.getBars(params.ref, {
      interval: plan.intrabarInterval,
      start: firstBar.date.slice(0, 10),
      // Round the target period's exclusive end up to midnight so both
      // inclusive-day vendors and midnight-timestamp brokers cover it fully.
      end: new Date(Math.ceil(end / 86_400_000) * 86_400_000).toISOString().slice(0, 10),
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
