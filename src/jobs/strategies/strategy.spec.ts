import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyTraderStrategyPatch,
  createTraderStrategy,
  getTraderStrategy,
  listTraderStrategySummaries,
  listTraderStrategyTemplates,
  loadTraderStrategies,
  updateTraderStrategy,
} from './strategy.js'

describe('trader strategy registry', () => {
  let cwd: string
  let tempDir: string

  beforeEach(async () => {
    cwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'oa-trader-strategy-'))
    process.chdir(tempDir)
    await mkdir(join(tempDir, 'runtime/strategies'), { recursive: true })
    await writeFile(join(tempDir, 'runtime/strategies/momentum.yml'), `
id: momentum
label: Momentum
enabled: true
sources: [ccxt-main]
universe:
  asset: crypto
  symbols: [BTC/USDT:USDT, ETH/USDT:USDT]
timeframes:
  context: 1h
  structure: 15m
  execution: 5m
riskBudget:
  perTradeRiskPercent: 0.5
  maxGrossExposurePercent: 5
  maxPositions: 2
behaviorRules:
  preferences: [trade with the trend]
  prohibitions: [no chasing]
executionPolicy:
  allowedOrderTypes: [stop, stop_limit]
  requireProtection: true
  allowMarketOrders: false
  allowOvernight: false
`.trimStart(), 'utf-8')
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads strategy yaml files from runtime/strategies', async () => {
    const strategies = await loadTraderStrategies()
    expect(strategies).toHaveLength(1)
    expect(strategies[0]).toMatchObject({
      id: 'momentum',
      label: 'Momentum',
      sources: ['ccxt-main'],
      universe: {
        asset: 'crypto',
        symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      },
    })
  })

  it('gets a strategy by id and exposes summaries', async () => {
    await expect(getTraderStrategy('momentum')).resolves.toMatchObject({ id: 'momentum' })
    await expect(getTraderStrategy('missing')).resolves.toBeNull()
    await expect(listTraderStrategySummaries()).resolves.toEqual([
      {
        id: 'momentum',
        label: 'Momentum',
        enabled: true,
        sources: ['ccxt-main'],
        asset: 'crypto',
        symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      },
    ])
  })

  it('lists built-in strategy templates', () => {
    expect(listTraderStrategyTemplates().map((template) => template.id)).toEqual([
      'breakout',
      'trend-follow',
      'mean-revert',
    ])
  })

  it('creates a new strategy yaml file and auto-suffixes duplicate ids', async () => {
    const created = await createTraderStrategy({
      id: 'momentum',
      label: 'Momentum Clone',
      enabled: true,
      sources: ['binance-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: ['breakout only'], prohibitions: ['no middle trades'] },
      executionPolicy: { allowedOrderTypes: ['stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
    })

    expect(created.id).toBe('momentum-2')
    await expect(readFile(join(tempDir, 'runtime/strategies/momentum-2.yml'), 'utf-8')).resolves.toContain('label: Momentum Clone')
  })

  it('applies a behavior-rules patch without touching risk budget', async () => {
    const result = await applyTraderStrategyPatch('momentum', {
      behaviorRules: {
        preferences: ['Long only after a 5m close above 75471.03.'],
        prohibitions: ['Do not keep the breakout if price returns to the decision zone within 30 minutes.'],
      },
    })

    expect(result.patchApplied).toBe(true)
    expect(result.strategy.behaviorRules).toEqual({
      preferences: ['Long only after a 5m close above 75471.03.'],
      prohibitions: ['Do not keep the breakout if price returns to the decision zone within 30 minutes.'],
    })
    expect(result.strategy.riskBudget).toMatchObject({
      perTradeRiskPercent: 0.5,
      maxGrossExposurePercent: 5,
      maxPositions: 2,
    })
  })

  it('updates an existing strategy while keeping the route id stable', async () => {
    const result = await updateTraderStrategy('momentum', {
      id: 'renamed',
      label: 'Momentum v2',
      enabled: false,
      sources: ['paper-main'],
      universe: { asset: 'crypto', symbols: ['ETH/USDT:USDT'] },
      timeframes: { context: '4h', structure: '1h', execution: '15m' },
      riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 4, maxPositions: 1 },
      behaviorRules: { preferences: ['trade pullbacks only'], prohibitions: ['no overnight'] },
      executionPolicy: { allowedOrderTypes: ['limit', 'stop'], requireProtection: true, allowMarketOrders: false, allowOvernight: false },
    })

    expect(result.strategy.id).toBe('momentum')
    expect(result.strategy.label).toBe('Momentum v2')
    expect(result.strategy.sources).toEqual(['paper-main'])
    expect(result.changeReport.summary).toContain('Manual edit updated')
    expect(result.changeReport.yamlDiff).toContain('+ label: Momentum v2')

    const saved = await getTraderStrategy('momentum')
    expect(saved).toMatchObject({
      id: 'momentum',
      label: 'Momentum v2',
      enabled: false,
      sources: ['paper-main'],
      universe: { symbols: ['ETH/USDT:USDT'] },
    })
  })
})
