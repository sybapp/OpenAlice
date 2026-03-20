import { describe, expect, it, vi } from 'vitest'
import { createStrategiesRoutes } from './strategies.js'

vi.mock('../../../jobs/strategies/index.js', () => ({
  listTraderStrategyTemplates: vi.fn(() => [
    {
      id: 'breakout',
      label: 'Breakout',
      description: 'Breakout template',
      defaults: {
        id: 'breakout',
        label: 'Breakout',
        enabled: true,
        sources: ['binance-main'],
        universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
        timeframes: { context: '1h', structure: '15m', execution: '5m' },
        riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
        behaviorRules: { preferences: [], prohibitions: [] },
        executionPolicy: { allowedOrderTypes: ['stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
      },
    },
  ]),
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
  generateTraderStrategyDraft: vi.fn(async () => ({
    draft: {
      id: 'breakout-btc',
      label: 'BTC Breakout',
      enabled: true,
      sources: ['binance-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: ['breakout only'], prohibitions: ['no middle trades'] },
      executionPolicy: { allowedOrderTypes: ['stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
    },
    yamlPreview: 'id: breakout-btc\nlabel: BTC Breakout\n',
  })),
  createTraderStrategy: vi.fn(async (strategy: any) => strategy),
  updateTraderStrategy: vi.fn(async (strategyId: string, strategy: any) => ({
    strategy: { ...strategy, id: strategyId },
    changeReport: {
      changedFields: ['label', 'preferences'],
      summary: 'Manual edit updated label, preferences.',
      yamlDiff: '- label: Momentum\n+ label: Momentum v2',
    },
  })),
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
    eventLog: {
      append: vi.fn(async () => undefined),
    },
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

  it('lists strategy templates', async () => {
    const app = createStrategiesRoutes(makeCtx())
    const res = await app.request('/templates')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      templates: [
        {
          id: 'breakout',
          label: 'Breakout',
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

  it('generates a strategy draft preview with AI', async () => {
    const ctx = makeCtx()
    const app = createStrategiesRoutes(ctx)
    const res = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'breakout',
        request: 'Long BTC only after reclaiming resistance.',
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      draft: {
        id: 'breakout-btc',
      },
      yamlPreview: expect.stringContaining('id: breakout-btc'),
    })
  })

  it('creates a strategy yaml-backed draft', async () => {
    const app = createStrategiesRoutes(makeCtx())
    const res = await app.request('/strategies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'breakout-btc',
        label: 'BTC Breakout',
        enabled: true,
        sources: ['binance-main'],
        universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
        timeframes: { context: '1h', structure: '15m', execution: '5m' },
        riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
        behaviorRules: { preferences: ['breakout only'], prohibitions: ['no middle trades'] },
        executionPolicy: { allowedOrderTypes: ['stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: 'breakout-btc',
      label: 'BTC Breakout',
    })
  })

  it('updates an existing strategy yaml file', async () => {
    const ctx = makeCtx()
    const app = createStrategiesRoutes(ctx)
    const res = await app.request('/strategies/momentum', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'another-id',
        label: 'Momentum v2',
        enabled: true,
        sources: ['ccxt-main'],
        universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
        timeframes: { context: '1h', structure: '15m', execution: '5m' },
        riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
        behaviorRules: { preferences: ['update triggers'], prohibitions: ['no chop'] },
        executionPolicy: { allowedOrderTypes: ['stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      strategy: {
        label: 'Momentum v2',
      },
      changeReport: {
        summary: 'Manual edit updated label, preferences.',
      },
    })
    expect(ctx.eventLog.append).toHaveBeenCalledWith('strategy.updated', expect.objectContaining({
      strategyId: 'momentum',
      source: 'manual',
      summary: 'Manual edit updated label, preferences.',
      yamlDiff: '- label: Momentum\n+ label: Momentum v2',
    }))
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
