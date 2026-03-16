import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBacktestStorage } from './storage.js'
import { createBacktestRunManager } from './manager.js'
import type { Engine } from '../../../core/engine.js'
import { SessionStore } from '../../../core/session.js'

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

describe('createBacktestRunManager', () => {
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
})
