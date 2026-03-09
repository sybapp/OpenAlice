import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBacktestStorage } from './storage.js'
import { createBacktestRunManager } from './manager.js'
import type { Engine } from '../../../core/engine.js'

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

  it('runs ai backtests and persists session transcript', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('ai') })
    const engine = {
      ask: vi.fn(),
      askWithSession: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            text: 'buy one lot',
            operations: [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } }],
          }),
          media: [],
        })
        .mockResolvedValue({
          text: JSON.stringify({ text: 'hold', operations: [] }),
          media: [],
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
    expect(sessionEntries.length).toBeGreaterThan(0)
    expect(summary?.tradeCount).toBe(1)
    expect(engine.askWithSession).toHaveBeenCalled()
  })
})
