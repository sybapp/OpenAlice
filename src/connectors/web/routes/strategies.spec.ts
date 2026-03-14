import { describe, expect, it, vi } from 'vitest'
import { createStrategiesRoutes } from './strategies.js'

vi.mock('../../../jobs/strategies/index.js', () => ({
  listTraderStrategySummaries: vi.fn(async () => [
    {
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      asset: 'crypto',
      symbols: ['BTC/USDT:USDT'],
    },
  ]),
  getTraderStrategy: vi.fn(async (id: string) => id === 'momentum'
    ? {
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: [], prohibitions: [] },
      executionPolicy: { allowedOrderTypes: ['stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
    }
    : null),
}))

function makeCtx() {
  return {
    trader: {
      list: vi.fn(() => [{ id: 'job-1', name: 'Momentum', strategyId: 'momentum' }]),
      add: vi.fn(async () => 'job-2'),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      runNow: vi.fn(async () => undefined),
    },
    traderReview: {
      list: vi.fn(() => [{ id: 'review-1', name: 'Weekly Review', strategyId: 'momentum' }]),
      add: vi.fn(async () => 'review-2'),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      runNow: vi.fn(async () => undefined),
    },
    runTraderReview: vi.fn(async (strategyId?: string) => ({
      updated: true,
      summary: 'review complete',
      strategyId,
    })),
  } as any
}

describe('createStrategiesRoutes', () => {
  it('lists strategies', async () => {
    const app = createStrategiesRoutes(makeCtx())
    const res = await app.request('/strategies')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      strategies: [
        {
          id: 'momentum',
          label: 'Momentum',
          enabled: true,
          sources: ['ccxt-main'],
          asset: 'crypto',
          symbols: ['BTC/USDT:USDT'],
        },
      ],
    })
  })

  it('returns full strategy details', async () => {
    const app = createStrategiesRoutes(makeCtx())
    const res = await app.request('/strategies/momentum')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: 'momentum',
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 1 },
    })
  })

  it('creates a strategy job', async () => {
    const ctx = makeCtx()
    const app = createStrategiesRoutes(ctx)
    const res = await app.request('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Momentum Job',
        strategyId: 'momentum',
        schedule: { kind: 'every', every: '1h' },
      }),
    })

    expect(res.status).toBe(200)
    expect(ctx.trader.add).toHaveBeenCalledWith({
      name: 'Momentum Job',
      strategyId: 'momentum',
      schedule: { kind: 'every', every: '1h' },
      enabled: undefined,
    })
  })

  it('runs a manual review', async () => {
    const ctx = makeCtx()
    const app = createStrategiesRoutes(ctx)
    const res = await app.request('/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategyId: 'momentum' }),
    })

    expect(res.status).toBe(200)
    expect(ctx.runTraderReview).toHaveBeenCalledWith('momentum')
    expect(await res.json()).toEqual({
      updated: true,
      summary: 'review complete',
      strategyId: 'momentum',
    })
  })

  it('creates a scheduled review job', async () => {
    const ctx = makeCtx()
    const app = createStrategiesRoutes(ctx)
    const res = await app.request('/review/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Weekly Review',
        strategyId: 'momentum',
        schedule: { kind: 'cron', cron: '0 18 * * 5' },
      }),
    })

    expect(res.status).toBe(200)
    expect(ctx.traderReview.add).toHaveBeenCalledWith({
      name: 'Weekly Review',
      strategyId: 'momentum',
      schedule: { kind: 'cron', cron: '0 18 * * 5' },
      enabled: undefined,
    })
    expect(await res.json()).toEqual({ id: 'review-2' })
  })
})
