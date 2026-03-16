import { beforeEach, describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBacktestStorage } from './storage.js'

const mocks = vi.hoisted(() => ({
  createEventLogOverride: null as null | ((...args: unknown[]) => Promise<unknown>),
}))

vi.mock('../../../core/event-log.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/event-log.js')>('../../../core/event-log.js')
  return {
    ...actual,
    createEventLog: (...args: Parameters<typeof actual.createEventLog>) => {
      if (mocks.createEventLogOverride) {
        return mocks.createEventLogOverride(...args) as ReturnType<typeof actual.createEventLog>
      }
      return actual.createEventLog(...args)
    },
  }
})

import { createBacktestRunManager } from './manager.js'
import type { Engine } from '../../../core/engine.js'
import { SessionStore } from '../../../core/session.js'
import type { BacktestStorage } from './types.js'

function tempDir(name: string) {
  return join(tmpdir(), `backtest-manager-${name}-${randomUUID()}`)
}

function makeBars() {
  return [
    { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
    { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 102, high: 103, low: 101, close: 102, volume: 1_000 },
    { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 104, high: 105, low: 103, close: 104, volume: 1_000 },
  ]
}

function makeBarsCount(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ts: new Date(Date.UTC(2025, 0, 1, 9, 30 + index)).toISOString(),
    symbol: 'AAPL',
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1_000,
  }))
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

describe('createBacktestRunManager', () => {
  beforeEach(() => {
    mocks.createEventLogOverride = null
  })

  it('runs scripted backtests and persists artifacts', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('scripted') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'scripted',
        decisions: [
          { step: 1, operations: [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }] },
        ],
      },
    })

    const manifest = await manager.waitForRun(runId)
    const summary = await manager.getSummary(runId)
    const equity = await manager.getEquityCurve(runId)
    const events = await manager.getEvents(runId)
    const git = await manager.getGitState(runId)

    expect(manifest.status).toBe('completed')
    expect(summary?.tradeCount).toBe(1)
    expect(equity.length).toBeGreaterThan(0)
    expect(events.some((entry) => entry.type === 'backtest.run.completed')).toBe(true)
    expect(git?.commits.length).toBeGreaterThan(0)
    expect(engine.askWithSession).not.toHaveBeenCalled()
  })

  it('rejects invalid external runIds', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('invalid-runid') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })

    await expect(manager.startRun({
      runId: '../escape',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })).rejects.toThrow('Invalid backtest runId:')
  })

  it('runs ai backtests and persists one user/assistant entry per decision', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('ai') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn().mockImplementation(async (prompt: string, session: SessionStore) => {
        await session.appendUser(prompt, 'human')
        await session.appendAssistant(JSON.stringify({ text: 'hold', operations: [] }), 'engine')
        return {
          text: JSON.stringify({ text: 'hold', operations: [] }),
          media: [],
        }
      }),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })

    const manifest = await manager.waitForRun(runId)
    const sessionEntries = await manager.getSessionEntries(runId)
    const summary = await manager.getSummary(runId)

    expect(manifest.status).toBe('completed')
    expect(manifest.sessionId).toBeDefined()
    expect(summary?.tradeCount).toBe(0)
    expect(engine.askWithSession).toHaveBeenCalledTimes(3)
    expect(sessionEntries).toHaveLength(6)
    expect(sessionEntries.filter((entry) => (entry as { type?: string }).type === 'user')).toHaveLength(3)
    expect(sessionEntries.filter((entry) => (entry as { type?: string }).type === 'assistant')).toHaveLength(3)
  })

  it('returns the persisted failed manifest from waitForRun when execution crashes', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('failed-run') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn().mockRejectedValue(new Error('model offline')),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })

    const manifest = await manager.waitForRun(runId)
    const events = await manager.getEvents(runId)

    expect(manifest.status).toBe('failed')
    expect(manifest.error).toBe('model offline')
    expect(events.some((entry) => entry.type === 'backtest.run.failed')).toBe(true)
  })

  it('does not emit a completed event when summary persistence fails after execution finishes', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('summary-persist-failure') })
    vi.spyOn(storage, 'writeSummary').mockRejectedValueOnce(new Error('summary disk offline'))
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })

    const manifest = await manager.waitForRun(runId)
    const events = await manager.getEvents(runId)

    expect(manifest.status).toBe('failed')
    expect(manifest.error).toBe('summary disk offline')
    expect(await manager.getSummary(runId)).toBeNull()
    expect(events.some((entry) => entry.type === 'backtest.run.completed')).toBe(false)
    expect(events.some((entry) => entry.type === 'backtest.run.failed')).toBe(true)
  })

  it('keeps a run completed when the completed event cannot be appended', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('completed-event-failure') })
    const append = vi.fn(async (type: string, payload: unknown) => {
      if (type === 'backtest.run.completed') {
        throw new Error('event sink offline')
      }
      return { seq: 1, ts: Date.now(), type, payload }
    })
    mocks.createEventLogOverride = vi.fn().mockResolvedValue({
      append,
      close: vi.fn().mockResolvedValue(undefined),
    })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })

    const manifest = await manager.waitForRun(runId)

    expect(manifest.status).toBe('completed')
    expect(manifest.error).toBeUndefined()
    await expect(manager.getSummary(runId)).resolves.toEqual(expect.objectContaining({ runId }))
    expect(append).toHaveBeenCalledWith('backtest.run.completed', expect.objectContaining({ runId }))
  })

  it('keeps the terminal completed event visible when callers request only a limited event tail', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('completed-event-tail') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBarsCount(550),
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })

    await expect(manager.waitForRun(runId)).resolves.toMatchObject({ status: 'completed' })

    const events = await manager.getEvents(runId, { limit: 50 })

    expect(events).toHaveLength(50)
    expect(events.at(-1)?.type).toBe('backtest.run.completed')
    expect(events.some((entry) => entry.type === 'backtest.run.completed')).toBe(true)
  })

  it('persists a failed manifest when startup crashes before the run reaches running state', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('event-log-init-failure') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    mocks.createEventLogOverride = vi.fn().mockRejectedValue(new Error('event log offline'))

    const manager = createBacktestRunManager({ storage, engine })
    const { runId } = await manager.startRun({
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })

    const manifest = await manager.waitForRun(runId)

    expect(manifest.status).toBe('failed')
    expect(manifest.error).toBe('event log offline')
    expect(manifest.startedAt).toBeUndefined()
    await expect(storage.listRuns()).resolves.toContainEqual(expect.objectContaining({ runId, status: 'failed' }))
  })

  it('does not leak a stale queued manifest through waitForRun when failed-state persistence also fails', async () => {
    const releaseRunId = vi.fn().mockResolvedValue(undefined)
    const storage = {
      claimRunId: vi.fn().mockResolvedValue(undefined),
      releaseRunId,
      createRun: vi.fn().mockResolvedValue(undefined),
      updateManifest: vi.fn()
        .mockResolvedValueOnce({ runId: 'stale-failure', status: 'running' })
        .mockRejectedValueOnce(new Error('manifest disk offline')),
      getManifest: vi.fn().mockResolvedValue({
        runId: 'stale-failure',
        status: 'queued',
        mode: 'ai',
        createdAt: '2025-01-01T00:00:00.000Z',
        artifactDir: '/tmp/stale-failure',
        barCount: 3,
        currentStep: 0,
        accountId: 'paper-1',
        accountLabel: 'Paper 1',
        initialCash: 10_000,
        guards: [],
      }),
      listRuns: vi.fn(),
      writeSummary: vi.fn(),
      readSummary: vi.fn(),
      appendEquityPoint: vi.fn(),
      readEquityCurve: vi.fn(),
      writeGitState: vi.fn(),
      readGitState: vi.fn(),
      readEventEntries: vi.fn(),
      readSessionEntries: vi.fn(),
      getRunPaths: vi.fn((runId: string) => ({
        runDir: `/tmp/${runId}`,
        manifestPath: `/tmp/${runId}/manifest.json`,
        summaryPath: `/tmp/${runId}/summary.json`,
        equityCurvePath: `/tmp/${runId}/equity-curve.jsonl`,
        eventLogPath: `/tmp/${runId}/events.jsonl`,
        gitStatePath: `/tmp/${runId}/git-state.json`,
      })),
    } satisfies BacktestStorage
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn().mockRejectedValue(new Error('model offline')),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })

    await expect(manager.startRun({
      runId: 'stale-failure',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })).resolves.toEqual({ runId: 'stale-failure' })

    await expect(manager.waitForRun('stale-failure')).rejects.toThrow('model offline')
    expect(storage.getManifest).toHaveBeenCalledWith('stale-failure')
    expect(releaseRunId).toHaveBeenCalledWith('stale-failure')
  })

  it('fails startRun immediately when the initial manifest cannot be persisted', async () => {
    const releaseRunId = vi.fn().mockResolvedValue(undefined)
    const storage = {
      claimRunId: vi.fn().mockResolvedValue(undefined),
      releaseRunId,
      createRun: vi.fn().mockRejectedValue(new Error('disk full')),
      updateManifest: vi.fn(),
      getManifest: vi.fn(),
      listRuns: vi.fn(),
      writeSummary: vi.fn(),
      readSummary: vi.fn(),
      appendEquityPoint: vi.fn(),
      readEquityCurve: vi.fn(),
      writeGitState: vi.fn(),
      readGitState: vi.fn(),
      readEventEntries: vi.fn(),
      readSessionEntries: vi.fn(),
      getRunPaths: vi.fn((runId: string) => ({
        runDir: `/tmp/${runId}`,
        manifestPath: `/tmp/${runId}/manifest.json`,
        summaryPath: `/tmp/${runId}/summary.json`,
        equityCurvePath: `/tmp/${runId}/equity-curve.jsonl`,
        eventLogPath: `/tmp/${runId}/events.jsonl`,
        gitStatePath: `/tmp/${runId}/git-state.json`,
      })),
    } satisfies BacktestStorage
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })

    await expect(manager.startRun({
      runId: 'persist-failure',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })).rejects.toThrow('disk full')

    expect(storage.claimRunId).toHaveBeenCalledWith('persist-failure')
    expect(releaseRunId).toHaveBeenCalledWith('persist-failure')
  })

  it('rejects invalid bar payloads before scheduling a run', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('invalid-bars') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })

    await expect(manager.startRun({
      initialCash: 10_000,
      startTime: '2025-01-01T09:40:00.000Z',
      bars: [
        { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 99, low: 98, close: 100, volume: 1_000 },
      ],
      strategy: {
        mode: 'scripted',
        decisions: [],
      },
    })).rejects.toThrow()

    await expect(storage.listRuns()).resolves.toEqual([])
  })

  it('rejects concurrent runs that reuse the same runId', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('duplicate-runid') })
    const reply = deferred<{ text: string; media: [] }>()
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn().mockImplementation(async (prompt: string, session: SessionStore) => {
        await session.appendUser(prompt, 'human')
        return reply.promise
      }),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })

    await expect(manager.startRun({
      runId: 'same-run',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })).resolves.toEqual({ runId: 'same-run' })

    await expect(manager.startRun({
      runId: 'same-run',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })).rejects.toThrow('Backtest run already in progress: same-run')

    reply.resolve({ text: JSON.stringify({ text: 'hold', operations: [] }), media: [] })
    await expect(manager.waitForRun('same-run')).resolves.toMatchObject({ status: 'completed' })
  })

  it('rejects the same runId across manager instances while the first run is active', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('cross-manager-runid') })
    const reply = deferred<{ text: string; media: [] }>()
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn().mockImplementation(async (prompt: string, session: SessionStore) => {
        await session.appendUser(prompt, 'human')
        return reply.promise
      }),
    } as unknown as Engine

    const managerA = createBacktestRunManager({ storage, engine })
    const managerB = createBacktestRunManager({ storage, engine })

    await expect(managerA.startRun({
      runId: 'shared-run',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })).resolves.toEqual({ runId: 'shared-run' })

    await expect(managerB.startRun({
      runId: 'shared-run',
      initialCash: 10_000,
      bars: makeBars(),
      strategy: {
        mode: 'ai',
        prompt: 'Trade the replay.',
      },
    })).rejects.toThrow('Backtest run already in progress: shared-run')

    reply.resolve({ text: JSON.stringify({ text: 'hold', operations: [] }), media: [] })
    await expect(managerA.waitForRun('shared-run')).resolves.toMatchObject({ status: 'completed' })
  })

  it('returns a failed manifest from waitForRun when a queued run is orphaned before execution resumes', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('orphaned-wait') })
    await storage.createRun({
      runId: 'orphaned-wait',
      status: 'queued',
      mode: 'scripted',
      createdAt: '2025-01-01T00:00:00.000Z',
      artifactDir: storage.getRunPaths('orphaned-wait').runDir,
      barCount: 3,
      currentStep: 0,
      accountId: 'paper-1',
      accountLabel: 'Paper 1',
      initialCash: 10_000,
      guards: [],
    })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi.fn(),
    } as unknown as Engine

    const manager = createBacktestRunManager({ storage, engine })

    await expect(manager.waitForRun('orphaned-wait')).resolves.toMatchObject({
      runId: 'orphaned-wait',
      status: 'failed',
      error: 'Backtest run became orphaned while still queued.',
    })
  })
})
