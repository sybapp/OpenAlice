import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import { createTraderJobEngine } from './job-engine.js'
import type { TraderFirePayload, TraderJobEngine } from './types.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `trader-job-test-${randomUUID()}.${ext}`)
}

describe('trader job engine', () => {
  let eventLog: EventLog
  let engine: TraderJobEngine
  let storePath: string
  let logPath: string
  let clock: number

  beforeEach(async () => {
    logPath = tempPath('jsonl')
    storePath = tempPath('json')
    eventLog = await createEventLog({ logPath })
    clock = Date.now()
    engine = createTraderJobEngine({
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

  it('adds and lists jobs', async () => {
    const id = await engine.add({
      name: 'momentum',
      strategyId: 'momentum',
      schedule: { kind: 'every', every: '1h' },
    })

    expect(id).toHaveLength(8)
    expect(engine.list()).toEqual([
      expect.objectContaining({
        id,
        name: 'momentum',
        strategyId: 'momentum',
        enabled: true,
      }),
    ])
  })

  it('fires trader.fire on runNow', async () => {
    const fired: EventLogEntry[] = []
    eventLog.subscribeType('trader.fire', (entry) => fired.push(entry))
    const id = await engine.add({
      name: 'job',
      strategyId: 'momentum',
      schedule: { kind: 'every', every: '1h' },
    })

    await engine.runNow(id)

    expect(fired).toHaveLength(1)
    expect(fired[0].payload as TraderFirePayload).toMatchObject({
      jobId: id,
      jobName: 'job',
      strategyId: 'momentum',
    })
  })

  it('recovers persisted jobs on restart', async () => {
    await engine.add({
      name: 'persisted',
      strategyId: 'momentum',
      schedule: { kind: 'every', every: '2h' },
    })
    engine.stop()

    const engine2 = createTraderJobEngine({
      eventLog,
      storePath,
      now: () => clock,
    })
    await engine2.start()

    expect(engine2.list()).toEqual([
      expect.objectContaining({
        name: 'persisted',
        strategyId: 'momentum',
      }),
    ])

    engine2.stop()
  })
})
