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

  it('returns 404 for missing run summary', async () => {
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({
        getSummary: vi.fn().mockResolvedValue(null),
      }),
    })

    const res = await app.request('/runs/missing/summary')
    expect(res.status).toBe(404)
  })
})
