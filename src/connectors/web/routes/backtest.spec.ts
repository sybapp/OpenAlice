import { describe, it, expect, vi } from 'vitest'
import { createBacktestRoutes } from './backtest.js'

function makeBacktestManager(overrides: Partial<Parameters<typeof createBacktestRoutes>[0]['backtest']> = {}) {
  return {
    listRuns: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(),
    getSummary: vi.fn(),
    getEquityCurve: vi.fn(),
    getEvents: vi.fn(),
    getGitState: vi.fn(),
    getSessionEntries: vi.fn(),
    ...overrides,
  }
}

describe('createBacktestRoutes', () => {
  it('lists runs', async () => {
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({
        listRuns: vi.fn().mockResolvedValue([{ runId: 'run-1', status: 'completed' }]),
      }),
    })

    const res = await app.request('/runs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [{ runId: 'run-1', status: 'completed' }] })
  })

  it('creates a run', async () => {
    const startRun = vi.fn().mockResolvedValue({ runId: 'run-2' })
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
    })

    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        initialCash: 10_000,
        bars: [
          { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        ],
        strategy: { mode: 'scripted', decisions: [] },
      }),
    })

    expect(res.status).toBe(200)
    expect(startRun).toHaveBeenCalledOnce()
    expect(await res.json()).toEqual({ runId: 'run-2' })
  })

  it('rejects invalid runId on create', async () => {
    const startRun = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
    })

    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: '../escape',
        initialCash: 10_000,
        bars: [
          { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        ],
        strategy: { mode: 'scripted', decisions: [] },
      }),
    })

    expect(res.status).toBe(400)
    expect(startRun).not.toHaveBeenCalled()
  })

  it('rejects invalid runId in path params', async () => {
    const getSummary = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ getSummary }),
    })

    const res = await app.request('/runs/..%2Fescape/summary')

    expect(res.status).toBe(400)
    expect(getSummary).not.toHaveBeenCalled()
  })
})
