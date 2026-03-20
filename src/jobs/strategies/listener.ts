import { SessionStore } from '../../core/session.js'
import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { TraderDecision, TraderFirePayload, TraderRunnerDeps, TraderRunnerResult } from './types.js'
import { runTraderJob } from './runner.js'

export interface TraderListener {
  start(): void
  stop(): Promise<void>
}

interface TraderListenerOpts extends TraderRunnerDeps {
  eventLog: EventLog
  connectorCenter?: ConnectorCenter
}

function buildTraderSessionId(jobId: string, strategyId: string): string {
  return `trader/${jobId}-${strategyId}`
}

function formatTraderErrorNotification(payload: TraderFirePayload, error: string): string {
  const compactError = error.replace(/\s+/g, ' ').trim().slice(0, 600)
  return [
    'OpenAlice 策略任务报错',
    `任务: ${payload.jobName} (${payload.jobId})`,
    `策略: ${payload.strategyId}`,
    `错误: ${compactError}`,
  ].join('\n')
}

function formatTraderDoneNotification(payload: TraderFirePayload, decision: TraderDecision, result: TraderRunnerResult): string {
  const actions = decision.actionsTaken.length > 0
    ? ['动作:', ...decision.actionsTaken.map((action) => `- ${action}`)]
    : []
  const invalidation = decision.invalidation.length > 0
    ? ['失效条件:', ...decision.invalidation.map((item) => `- ${item}`)]
    : []
  return [
    'OpenAlice 策略任务执行',
    `任务: ${payload.jobName} (${payload.jobId})`,
    `策略: ${payload.strategyId}`,
    `来源: ${decision.source}`,
    `标的: ${decision.symbol}`,
    `场景: ${decision.chosenScenario}`,
    `结果: ${result.reason}`,
    ...actions,
    ...invalidation,
  ].join('\n')
}

export function createTraderListener(opts: TraderListenerOpts): TraderListener {
  const sessions = new Map<string, SessionStore>()
  let unsubscribe: (() => void) | null = null
  const processingStrategies = new Set<string>()
  const inFlight = new Set<Promise<void>>()

  async function getSession(jobId: string, strategyId: string): Promise<SessionStore> {
    const sessionId = buildTraderSessionId(jobId, strategyId)
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const session = new SessionStore(sessionId)
    await session.restore()
    sessions.set(sessionId, session)
    return session
  }

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as TraderFirePayload
    const runId = String(entry.seq)
    if (processingStrategies.has(payload.strategyId)) {
      await opts.eventLog.append('trader.skip', {
        runId,
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        reason: 'overlap — same strategy is already processing',
      })
      return
    }

    processingStrategies.add(payload.strategyId)
    const startMs = Date.now()
    try {
      const session = await getSession(payload.jobId, payload.strategyId)
      const result = await runTraderJob({
        jobId: payload.jobId,
        strategyId: payload.strategyId,
        session,
        runId,
        jobName: payload.jobName,
      }, opts)

      const delivered = result.status === 'done' && result.decision && opts.connectorCenter
        ? await opts.connectorCenter.notify(formatTraderDoneNotification(payload, result.decision, result), { source: 'trader-done' })
        : { delivered: false as const }

      await opts.eventLog.append(result.status === 'skip' ? 'trader.skip' : 'trader.done', {
        runId,
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        reason: result.reason,
        durationMs: Date.now() - startMs,
        decision: result.decision,
        rawText: result.rawText,
        notified: delivered.delivered,
        channel: delivered.channel,
      })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      const delivered = opts.connectorCenter
        ? await opts.connectorCenter.notify(formatTraderErrorNotification(payload, errorText), { source: 'trader-error' })
        : { delivered: false as const }
      await opts.eventLog.append('trader.error', {
        runId,
        jobId: payload.jobId,
        jobName: payload.jobName,
        strategyId: payload.strategyId,
        error: errorText,
        durationMs: Date.now() - startMs,
        notified: delivered.delivered,
        channel: delivered.channel,
      })
    } finally {
      processingStrategies.delete(payload.strategyId)
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
