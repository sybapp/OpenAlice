import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import { createTraderReviewJobEngine } from './review-job-engine.js'
import type { TraderReviewFirePayload, TraderReviewJobEngine } from './types.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `trader-review-job-test-${randomUUID()}.${ext}`)
}

describe('trader review job engine', () => {
  let eventLog: EventLog
  let engine: TraderReviewJobEngine
  let storePath: string
  let logPath: string
  let clock: number

  beforeEach(async () => {
    logPath = tempPath('jsonl')
    storePath = tempPath('json')
    eventLog = await createEventLog({ logPath })
    clock = Date.now()
    engine = createTraderReviewJobEngine({
      eventLog,
      storePath,
      now: () => clock,
    })
  })

  afterEach(async () => {
    engine.stop()
    await eventLog._resetForTest()
    try { await unlink(storePath) } catch { /* ok */ }
  })

  it('adds and lists review jobs', async () => {
    const id = await engine.add({
      name: 'Weekly review',
      strategyId: 'momentum',
      schedule: { kind: 'cron', cron: '0 18 * * 5' },
    })

    expect(id).toHaveLength(8)
    expect(engine.list()).toEqual([
      expect.objectContaining({
        id,
        name: 'Weekly review',
        strategyId: 'momentum',
        enabled: true,
      }),
    ])
  })

  it('fires trader.review.fire on runNow', async () => {
    const fired: EventLogEntry[] = []
    eventLog.subscribeType('trader.review.fire', (entry) => fired.push(entry))
    const id = await engine.add({
      name: 'Daily review',
      schedule: { kind: 'every', every: '24h' },
    })

    await engine.runNow(id)

    expect(fired).toHaveLength(1)
    expect(fired[0].payload as TraderReviewFirePayload).toMatchObject({
      jobId: id,
      jobName: 'Daily review',
      strategyId: undefined,
    })
  })
})
