import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../../core/session.js'
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
      connectorCenter: { notify: vi.fn() } as never,
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

  it('allows different strategies to run concurrently', async () => {
    const gateA = deferred<{ status: 'done'; reason: string }>()
    const gateB = deferred<{ status: 'done'; reason: string }>()
    runTraderJob
      .mockReturnValueOnce(gateA.promise)
      .mockReturnValueOnce(gateB.promise)

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify: vi.fn() } as never,
      brain: {} as never,
      accountManager: {} as never,
      marketData: {} as never,
      ohlcvStore: {} as never,
      newsStore: {} as never,
      getAccountGit: () => undefined,
    })

    listener.start()
    await Promise.all([
      eventLog.append('trader.fire', {
        jobId: 'job-a',
        jobName: 'Momentum',
        strategyId: 'momentum',
      }),
      eventLog.append('trader.fire', {
        jobId: 'job-b',
        jobName: 'Mean Reversion',
        strategyId: 'mean-reversion',
      }),
    ])

    await vi.waitFor(() => expect(runTraderJob).toHaveBeenCalledTimes(2))

    gateA.resolve({ status: 'done', reason: 'momentum done' })
    gateB.resolve({ status: 'done', reason: 'mean reversion done' })
    await listener.stop()
  })

  it('skips overlapping fires for the same strategy only', async () => {
    const gate = deferred<{ status: 'done'; reason: string }>()
    const skipEvents: EventLogEntry[] = []
    runTraderJob.mockReturnValue(gate.promise)
    eventLog.subscribeType('trader.skip', (entry) => skipEvents.push(entry))

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify: vi.fn() } as never,
      brain: {} as never,
      accountManager: {} as never,
      marketData: {} as never,
      ohlcvStore: {} as never,
      newsStore: {} as never,
      getAccountGit: () => undefined,
    })

    listener.start()
    await eventLog.append('trader.fire', {
      jobId: 'job-a',
      jobName: 'Momentum',
      strategyId: 'momentum',
    })
    await vi.waitFor(() => expect(runTraderJob).toHaveBeenCalledOnce())

    await eventLog.append('trader.fire', {
      jobId: 'job-b',
      jobName: 'Momentum backup',
      strategyId: 'momentum',
    })

    await vi.waitFor(() => expect(skipEvents).toHaveLength(1))
    expect(skipEvents[0].payload).toMatchObject({
      jobId: 'job-b',
      strategyId: 'momentum',
      reason: 'overlap — same strategy is already processing',
    })

    gate.resolve({ status: 'done', reason: 'completed cleanly' })
    await listener.stop()
  })

  it('keeps separate sessions when the same job switches strategies', async () => {
    runTraderJob.mockResolvedValue({ status: 'skip', reason: 'no trade', rawText: '{}' })

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify: vi.fn() } as never,
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
      jobName: 'Trader Job',
      strategyId: 'btcusdt-auto-execution',
    })
    await eventLog.append('trader.fire', {
      jobId: 'job-1',
      jobName: 'Trader Job',
      strategyId: 'mean-revert',
    })

    await vi.waitFor(() => expect(runTraderJob).toHaveBeenCalledTimes(2))

    const firstSession = runTraderJob.mock.calls[0][0].session as SessionStore
    const secondSession = runTraderJob.mock.calls[1][0].session as SessionStore
    expect(firstSession.id).toBe('trader/job-1-btcusdt-auto-execution')
    expect(secondSession.id).toBe('trader/job-1-mean-revert')
    expect(secondSession.id).not.toBe(firstSession.id)

    await listener.stop()
  })

  it('reuses the same session for repeated fires of one strategy', async () => {
    runTraderJob.mockResolvedValue({ status: 'skip', reason: 'no trade', rawText: '{}' })

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify: vi.fn() } as never,
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
      jobName: 'Trader Job',
      strategyId: 'mean-revert',
    })
    await vi.waitFor(() => expect(runTraderJob).toHaveBeenCalledTimes(1))
    await eventLog.append('trader.fire', {
      jobId: 'job-1',
      jobName: 'Trader Job',
      strategyId: 'mean-revert',
    })

    await vi.waitFor(() => expect(runTraderJob).toHaveBeenCalledTimes(2))

    const firstSession = runTraderJob.mock.calls[0][0].session as SessionStore
    const secondSession = runTraderJob.mock.calls[1][0].session as SessionStore
    expect(secondSession).toBe(firstSession)
    expect(secondSession.id).toBe('trader/job-1-mean-revert')

    await listener.stop()
  })

  it('notifies through connectorCenter when a trader job completes a trade plan', async () => {
    const doneEvents: EventLogEntry[] = []
    const notify = vi.fn(async () => ({ delivered: true, channel: 'telegram' as const }))
    runTraderJob.mockResolvedValue({
      status: 'done',
      reason: 'Execution confirmed.',
      decision: {
        status: 'trade',
        strategyId: 'btcusdt-auto-execution',
        source: 'binance-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'short breakdown continuation',
        rationale: 'Execution confirmed.',
        invalidation: ['reclaim 75134.8'],
        actionsTaken: ['SELL stop BTC/USDT:USDT qty=0.02 stop=75134.8 -> pending (ord-1)'],
        brainUpdate: '',
      },
      rawText: '{"ok":true}',
    })
    eventLog.subscribeType('trader.done', (entry) => doneEvents.push(entry))

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify } as never,
      brain: {} as never,
      accountManager: {} as never,
      marketData: {} as never,
      ohlcvStore: {} as never,
      newsStore: {} as never,
      getAccountGit: () => undefined,
    })

    listener.start()
    await eventLog.append('trader.fire', {
      jobId: 'job-done',
      jobName: 'BTCUSDT Auto Execution',
      strategyId: 'btcusdt-auto-execution',
    })

    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(doneEvents).toHaveLength(1))

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('OpenAlice 策略任务执行'),
      { source: 'trader-done' },
    )
    expect(doneEvents[0].payload).toMatchObject({
      jobId: 'job-done',
      strategyId: 'btcusdt-auto-execution',
      notified: true,
      channel: 'telegram',
    })
  })

  it('does not notify or emit trader.done when the runner skips an all-rejected execution', async () => {
    const doneEvents: EventLogEntry[] = []
    const skipEvents: EventLogEntry[] = []
    const notify = vi.fn(async () => ({ delivered: true, channel: 'telegram' as const }))
    runTraderJob.mockResolvedValue({
      status: 'skip',
      reason: 'Execution failed: 2 order(s) were rejected.',
      rawText: '{"ok":false}',
    })
    eventLog.subscribeType('trader.done', (entry) => doneEvents.push(entry))
    eventLog.subscribeType('trader.skip', (entry) => skipEvents.push(entry))

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify } as never,
      brain: {} as never,
      accountManager: {} as never,
      marketData: {} as never,
      ohlcvStore: {} as never,
      newsStore: {} as never,
      getAccountGit: () => undefined,
    })

    listener.start()
    await eventLog.append('trader.fire', {
      jobId: 'job-skip',
      jobName: 'BTCUSDT Auto Execution',
      strategyId: 'btcusdt-auto-execution',
    })

    await vi.waitFor(() => expect(skipEvents).toHaveLength(1))

    expect(notify).not.toHaveBeenCalled()
    expect(doneEvents).toHaveLength(0)
    expect(skipEvents[0].payload).toMatchObject({
      jobId: 'job-skip',
      strategyId: 'btcusdt-auto-execution',
      reason: 'Execution failed: 2 order(s) were rejected.',
      notified: false,
    })
  })

  it('notifies through connectorCenter when a trader job errors', async () => {
    const errorEvents: EventLogEntry[] = []
    const notify = vi.fn(async () => ({ delivered: true, channel: 'telegram' as const }))
    runTraderJob.mockRejectedValue(new Error('market scan exploded'))
    eventLog.subscribeType('trader.error', (entry) => errorEvents.push(entry))

    const listener = createTraderListener({
      config: {} as never,
      engine: {} as never,
      eventLog,
      connectorCenter: { notify } as never,
      brain: {} as never,
      accountManager: {} as never,
      marketData: {} as never,
      ohlcvStore: {} as never,
      newsStore: {} as never,
      getAccountGit: () => undefined,
    })

    listener.start()
    await eventLog.append('trader.fire', {
      jobId: 'job-err',
      jobName: 'BTCUSDT Auto Execution',
      strategyId: 'btcusdt-auto-execution',
    })

    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(errorEvents).toHaveLength(1))

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('OpenAlice 策略任务报错'),
      { source: 'trader-error' },
    )
    expect(errorEvents[0].payload).toMatchObject({
      jobId: 'job-err',
      jobName: 'BTCUSDT Auto Execution',
      strategyId: 'btcusdt-auto-execution',
      error: 'market scan exploded',
      notified: true,
      channel: 'telegram',
    })
  })
})
