import { SessionStore } from '../../core/session.js'
import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import type { TraderFirePayload, TraderRunnerDeps } from './types.js'
import { runTraderJob } from './runner.js'

export interface TraderListener {
  start(): void
  stop(): Promise<void>
}

interface TraderListenerOpts extends TraderRunnerDeps {
  eventLog: EventLog
}

export function createTraderListener(opts: TraderListenerOpts): TraderListener {
  const sessions = new Map<string, SessionStore>()
  let unsubscribe: (() => void) | null = null
  let processing = false
  const inFlight = new Set<Promise<void>>()

  async function getSession(jobId: string): Promise<SessionStore> {
    const existing = sessions.get(jobId)
    if (existing) return existing
    const session = new SessionStore(`trader/${jobId}`)
    await session.restore()
    sessions.set(jobId, session)
    return session
  }

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as TraderFirePayload
    if (processing) {
      await opts.eventLog.append('trader.skip', {
        jobId: payload.jobId,
        strategyId: payload.strategyId,
        reason: 'overlap — previous trader job still processing',
      })
      return
    }

    processing = true
    const startMs = Date.now()
    try {
      const session = await getSession(payload.jobId)
      const result = await runTraderJob({
        jobId: payload.jobId,
        strategyId: payload.strategyId,
        session,
      }, opts)

      await opts.eventLog.append(result.status === 'skip' ? 'trader.skip' : 'trader.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        reason: result.reason,
        durationMs: Date.now() - startMs,
        decision: result.decision,
        rawText: result.rawText,
      })
    } catch (err) {
      await opts.eventLog.append('trader.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      })
    } finally {
      processing = false
    }
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = opts.eventLog.subscribeType('trader.fire', (entry) => {
        const task = handleFire(entry).catch((err) => {
          console.error('trader-listener: unhandled error:', err)
        }).finally(() => {
          inFlight.delete(task)
        })
        inFlight.add(task)
      })
    },

    async stop() {
      unsubscribe?.()
      unsubscribe = null
      if (inFlight.size === 0) return
      await Promise.allSettled([...inFlight])
    },
  }
}
