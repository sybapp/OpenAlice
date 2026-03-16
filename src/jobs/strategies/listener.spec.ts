import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import { createTraderListener } from './listener.js'

const { runTraderJob } = vi.hoisted(() => ({
  runTraderJob: vi.fn(),
}))

vi.mock('./runner.js', () => ({
  runTraderJob,
}))

function tempPath(ext: string): string {
  return join(tmpdir(), `trader-listener-test-${randomUUID()}.${ext}`)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('trader listener', () => {
  let eventLog: EventLog

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    runTraderJob.mockReset()
  })

  afterEach(async () => {
    await eventLog._resetForTest()
  })

  it('waits for an in-flight trader job before stop resolves', async () => {
    const gate = deferred<{ status: 'done'; reason: string }>()
    const doneEvents: EventLogEntry[] = []
    runTraderJob.mockReturnValue(gate.promise)
    eventLog.subscribeType('trader.done', (entry) => doneEvents.push(entry))

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      brain: {} as never,
      accountManager: {} as never,
      marketData: {} as never,
      ohlcvStore: {} as never,
      newsStore: {} as never,
      getAccountGit: () => undefined,
    })

    listener.start()
    await eventLog.append('trader.fire', {
      jobId: 'job-1',
      jobName: 'Momentum',
      strategyId: 'momentum',
    })

    await vi.waitFor(() => expect(runTraderJob).toHaveBeenCalledOnce())

    let stopped = false
    const stopPromise = listener.stop().then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(stopped).toBe(false)

    gate.resolve({ status: 'done', reason: 'completed cleanly' })
    await stopPromise

    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0].payload).toMatchObject({
      jobId: 'job-1',
      jobName: 'Momentum',
      strategyId: 'momentum',
      reason: 'completed cleanly',
    })
  })
})
