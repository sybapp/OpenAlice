import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import { runTraderReview } from './runner.js'
import type { TraderReviewFirePayload, TraderRunnerDeps } from './types.js'

export interface TraderReviewListener {
  start(): void
  stop(): void
}

interface TraderReviewListenerOpts extends Pick<TraderRunnerDeps, 'config' | 'engine' | 'brain' | 'accountManager' | 'marketData' | 'ohlcvStore' | 'newsStore' | 'getAccountGit' | 'eventLog'> {}

export function createTraderReviewListener(opts: TraderReviewListenerOpts): TraderReviewListener {
  let unsubscribe: (() => void) | null = null
  let processing = false

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as TraderReviewFirePayload
    if (processing) {
      await opts.eventLog.append('trader.review.skip', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        reason: 'overlap — previous trader review still processing',
      })
      return
    }

    processing = true
    try {
      await runTraderReview(payload.strategyId, opts, {
        trigger: 'scheduled',
        jobId: payload.jobId,
        jobName: payload.jobName,
      })
    } catch (err) {
      await opts.eventLog.append('trader.review.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      processing = false
    }
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = opts.eventLog.subscribeType('trader.review.fire', (entry) => {
        handleFire(entry).catch((err) => {
          console.error('trader-review-listener: unhandled error:', err)
        })
      })
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
