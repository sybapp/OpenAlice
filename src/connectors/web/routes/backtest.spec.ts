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

function makeMarketData(overrides: Partial<Parameters<typeof createBacktestRoutes>[0]['marketData']> = {}) {
  return {
    getBacktestBars: vi.fn(),
    ...overrides,
  }
}

describe('createBacktestRoutes', () => {
  it('lists runs', async () => {
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({
        listRuns: vi.fn().mockResolvedValue([{ runId: 'run-1', status: 'completed' }]),
      }),
      marketData: makeMarketData(),
    })

    const res = await app.request('/runs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [{ runId: 'run-1', status: 'completed' }] })
  })

  it('creates a run', async () => {
    const startRun = vi.fn().mockResolvedValue({ runId: 'run-2' })
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
      marketData: makeMarketData(),
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

  it('accepts zero initialCash on create', async () => {
    const startRun = vi.fn().mockResolvedValue({ runId: 'run-3' })
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
      marketData: makeMarketData(),
    })

    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        initialCash: 0,
        bars: [
          { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        ],
        strategy: { mode: 'scripted', decisions: [] },
      }),
    })

    expect(res.status).toBe(200)
    expect(startRun).toHaveBeenCalledOnce()
    expect(await res.json()).toEqual({ runId: 'run-3' })
  })

  it('rejects negative initialCash on create', async () => {
    const startRun = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
      marketData: makeMarketData(),
    })

    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        initialCash: -1,
        bars: [
          { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        ],
        strategy: { mode: 'scripted', decisions: [] },
      }),
    })

    expect(res.status).toBe(400)
    expect(startRun).not.toHaveBeenCalled()
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'Validation failed' }))
  })

  it('rejects invalid bars and out-of-range startTime on create', async () => {
    const startRun = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
      marketData: makeMarketData(),
    })

    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        initialCash: 10_000,
        startTime: '2025-01-01T10:00:00.000Z',
        bars: [
          { ts: 'not-a-timestamp', symbol: 'AAPL', open: 100, high: 99, low: 100, close: 100, volume: 1_000 },
        ],
        strategy: { mode: 'scripted', decisions: [] },
      }),
    })

    const payload = await res.json()
    expect(res.status).toBe(400)
    expect(startRun).not.toHaveBeenCalled()
    expect(payload).toEqual(expect.objectContaining({ error: 'Validation failed' }))
  })

  it('rejects invalid runId on create', async () => {
    const startRun = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ startRun }),
      marketData: makeMarketData(),
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
      marketData: makeMarketData(),
    })

    const res = await app.request('/runs/..%2Fescape/summary')

    expect(res.status).toBe(400)
    expect(getSummary).not.toHaveBeenCalled()
  })

  it('returns 404 for missing run artifact endpoints', async () => {
    const missing = vi.fn().mockRejectedValue(new Error('Backtest run not found: missing-run'))
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({
        getEquityCurve: missing,
        getEvents: missing,
        getSessionEntries: missing,
      }),
      marketData: makeMarketData(),
    })

    const [equityRes, eventsRes, sessionRes] = await Promise.all([
      app.request('/runs/missing-run/equity'),
      app.request('/runs/missing-run/events'),
      app.request('/runs/missing-run/session'),
    ])

    expect(equityRes.status).toBe(404)
    expect(await equityRes.json()).toEqual({ error: 'Backtest run not found: missing-run' })
    expect(eventsRes.status).toBe(404)
    expect(await eventsRes.json()).toEqual({ error: 'Backtest run not found: missing-run' })
    expect(sessionRes.status).toBe(404)
    expect(await sessionRes.json()).toEqual({ error: 'Backtest run not found: missing-run' })
  })

  it('rejects invalid event and equity pagination query params', async () => {
    const getEquityCurve = vi.fn()
    const getEvents = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager({ getEquityCurve, getEvents }),
      marketData: makeMarketData(),
    })

    const [equityRes, eventsLimitRes, eventsAfterSeqRes] = await Promise.all([
      app.request('/runs/run-1/equity?limit=-1'),
      app.request('/runs/run-1/events?limit=abc'),
      app.request('/runs/run-1/events?afterSeq=-2'),
    ])

    expect(equityRes.status).toBe(400)
    expect(await equityRes.json()).toEqual({ error: 'Invalid limit: expected a positive integer' })
    expect(eventsLimitRes.status).toBe(400)
    expect(await eventsLimitRes.json()).toEqual({ error: 'Invalid limit: expected a positive integer' })
    expect(eventsAfterSeqRes.status).toBe(400)
    expect(await eventsAfterSeqRes.json()).toEqual({ error: 'Invalid afterSeq: expected a non-negative integer' })
    expect(getEquityCurve).not.toHaveBeenCalled()
    expect(getEvents).not.toHaveBeenCalled()
  })

  it('returns normalized bars for valid queries', async () => {
    const getBacktestBars = vi.fn().mockResolvedValue([
      { ts: '2025-01-01T00:00:00.000Z', symbol: 'BTC/USDT', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    ])
    const app = createBacktestRoutes({
      backtest: makeBacktestManager(),
      marketData: makeMarketData({ getBacktestBars }),
    })

    const res = await app.request('/bars?assetType=crypto&symbol=BTCUSDT&startDate=2025-01-01&endDate=2025-01-31')

    expect(res.status).toBe(200)
    expect(getBacktestBars).toHaveBeenCalledWith({
      assetType: 'crypto',
      symbol: 'BTCUSDT',
      startDate: '2025-01-01',
      endDate: '2025-01-31',
    })
    expect(await res.json()).toEqual({
      bars: [{ ts: '2025-01-01T00:00:00.000Z', symbol: 'BTC/USDT', open: 100, high: 101, low: 99, close: 100, volume: 1000 }],
    })
  })

  it('accepts interval for crypto bars', async () => {
    const getBacktestBars = vi.fn().mockResolvedValue([])
    const app = createBacktestRoutes({
      backtest: makeBacktestManager(),
      marketData: makeMarketData({ getBacktestBars }),
    })

    const res = await app.request('/bars?assetType=crypto&symbol=BTCUSD&startDate=2025-01-01&endDate=2025-01-31&interval=1h')

    expect(res.status).toBe(200)
    expect(getBacktestBars).toHaveBeenCalledWith({
      assetType: 'crypto',
      symbol: 'BTCUSD',
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      interval: '1h',
    })
  })

  it('rejects invalid bar query parameters', async () => {
    const getBacktestBars = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager(),
      marketData: makeMarketData({ getBacktestBars }),
    })

    const res = await app.request('/bars?assetType=fx&symbol=EURUSD&startDate=2025-01-01&endDate=2025-01-31&interval=1h')

    expect(res.status).toBe(400)
    expect(getBacktestBars).not.toHaveBeenCalled()
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'Validation failed' }))
  })

  it('rejects bar queries whose endDate is before startDate', async () => {
    const getBacktestBars = vi.fn()
    const app = createBacktestRoutes({
      backtest: makeBacktestManager(),
      marketData: makeMarketData({ getBacktestBars }),
    })

    const res = await app.request('/bars?assetType=crypto&symbol=BTCUSD&startDate=2025-01-31&endDate=2025-01-01')

    expect(res.status).toBe(400)
    expect(getBacktestBars).not.toHaveBeenCalled()
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'Validation failed' }))
  })
})
