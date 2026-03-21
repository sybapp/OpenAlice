/**
 * Cron Listener — subscribes to `cron.fire` events from the EventLog
 * and routes them through the AI Engine for processing.
 *
 * Flow:
 *   eventLog 'cron.fire' → engine.askWithSession(payload, session)
 *                         → parse STATUS (CHAT_YES/CHAT_NO, optional)
 *                         → connectorCenter.notify(reply) when CHAT_YES
 *                         → eventLog 'cron.done' / 'cron.error'
 *
 * The listener owns a dedicated SessionStore for cron conversations,
 * independent of user chat sessions (Telegram, Web, etc.).
 */

import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import type { EngineAskOptions } from '../../core/engine.js'
import type { StreamableResult } from '../../core/ai-provider.js'
import { SessionStore } from '../../core/session.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { CronFirePayload } from './engine.js'
import { HEARTBEAT_JOB_NAME } from '../heartbeat/heartbeat.js'

export type CronChatStatus = 'CHAT_YES' | 'CHAT_NO'

interface ParsedCronResponse {
  status: CronChatStatus
  reason: string
  content: string
  unparsed: boolean
}

/**
 * Parse optional structured cron responses.
 *
 * Expected format:
 *   STATUS: CHAT_YES | CHAT_NO
 *   REASON: <text>
 *   CONTENT: <text>  (only for CHAT_YES)
 *
 * Also accepts a bare NO_REPLY as an explicit silent ack.
 *
 * Backward compatible: if STATUS is missing, treat the whole raw text as CHAT_YES.
 */
export function parseCronResponse(raw: string): ParsedCronResponse {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { status: 'CHAT_NO', reason: 'empty response', content: '', unparsed: false }
  }

  if (trimmed === 'NO_REPLY') {
    return { status: 'CHAT_NO', reason: 'no-reply', content: '', unparsed: false }
  }

  const statusMatch = /^\s*STATUS:\s*(CHAT_YES|CHAT_NO)\s*$/im.exec(trimmed)
  if (!statusMatch) {
    return { status: 'CHAT_YES', reason: 'unparsed response', content: trimmed, unparsed: true }
  }

  const status = statusMatch[1].toUpperCase() as CronChatStatus
  const reasonMatch = /^\s*REASON:\s*(.+?)(?=\n\s*(?:STATUS|CONTENT):|\s*$)/ims.exec(trimmed)
  const contentMatch = /^\s*CONTENT:\s*(.+)/ims.exec(trimmed)

  return {
    status,
    reason: reasonMatch?.[1]?.trim() ?? '',
    content: contentMatch?.[1]?.trim() ?? '',
    unparsed: false,
  }
}

// ==================== Types ====================

export interface JobSessionRuntime {
  askWithSession(prompt: string, session: SessionStore, opts?: EngineAskOptions): StreamableResult
}

export interface CronListenerOpts {
  connectorCenter: ConnectorCenter
  eventLog: EventLog
  runtime: JobSessionRuntime
  /** Optional: inject a session for testing. Otherwise creates a dedicated cron session. */
  session?: SessionStore
}

export interface CronListener {
  start(): void
  stop(): void
}

// ==================== Factory ====================

export function createCronListener(opts: CronListenerOpts): CronListener {
  const { connectorCenter, eventLog, runtime } = opts
  const session = opts.session ?? new SessionStore('cron/default')

  let unsubscribe: (() => void) | null = null
  let processing = false

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as CronFirePayload

    // Guard: heartbeat events are handled by the heartbeat listener
    if (payload.jobName === HEARTBEAT_JOB_NAME) return

    // Guard: skip if already processing (serial execution)
    if (processing) {
      console.warn(`cron-listener: skipping job ${payload.jobId} (already processing)`)
      await eventLog.append('cron.skipped', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        reason: 'overlap — previous job still processing',
      })
      return
    }

    processing = true
    const startMs = Date.now()

    try {
      // Ask the AI engine with the cron payload
      const result = await runtime.askWithSession(payload.payload, session, {
        historyPreamble: 'The following is the recent cron session conversation. This is an automated cron job execution.',
      })

      const parsed = parseCronResponse(result.text)
      const text = parsed.content || result.text

      let delivered = false
      if (parsed.status === 'CHAT_YES' && text.trim()) {
        // Send notification through the last-interacted connector
        try {
          const sendResult = await connectorCenter.notify(text, {
            media: result.media,
            source: 'cron',
          })
          delivered = sendResult.delivered
        } catch (sendErr) {
          console.warn(`cron-listener: send failed for job ${payload.jobId}:`, sendErr)
        }
      }

      // Log success
      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        reply: text,
        status: parsed.status,
        reason: parsed.reason,
        delivered,
        durationMs: Date.now() - startMs,
      })
    } catch (err) {
      console.error(`cron-listener: error processing job ${payload.jobId}:`, err)

      // Log error
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      })
    } finally {
      processing = false
    }
  }

  return {
    start() {
      if (unsubscribe) return // already started
      unsubscribe = eventLog.subscribeType('cron.fire', (entry) => {
        // Fire-and-forget — errors are caught inside handleFire
        handleFire(entry).catch((err) => {
          console.error('cron-listener: unhandled error in handleFire:', err)
        })
      })
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
