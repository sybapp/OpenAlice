import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import { createTraderReviewListener } from './review-listener.js'

const { runTraderReview } = vi.hoisted(() => ({
  runTraderReview: vi.fn(),
}))

vi.mock('./runner.js', () => ({
  runTraderReview,
}))

function tempPath(ext: string): string {
  return join(tmpdir(), `trader-review-listener-test-${randomUUID()}.${ext}`)
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

describe('trader review listener', () => {
  let eventLog: EventLog

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    runTraderReview.mockReset()
  })

  afterEach(async () => {
    await eventLog._resetForTest()
  })

  it('waits for an in-flight review before stop resolves', async () => {
    const gate = deferred<void>()
    const errorEvents: EventLogEntry[] = []
    runTraderReview.mockReturnValue(gate.promise)
    eventLog.subscribeType('trader.review.error', (entry) => errorEvents.push(entry))

    const listener = createTraderReviewListener({
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
    await eventLog.append('trader.review.fire', {
      jobId: 'review-1',
      jobName: 'Weekly review',
      strategyId: 'swing',
    })

    await vi.waitFor(() => expect(runTraderReview).toHaveBeenCalledOnce())

    let stopped = false
    const stopPromise = listener.stop().then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(stopped).toBe(false)

    gate.resolve()
    await stopPromise

    expect(errorEvents).toHaveLength(0)
  })
})
