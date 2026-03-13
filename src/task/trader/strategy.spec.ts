import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getTraderStrategy, listTraderStrategySummaries, loadTraderStrategies } from './strategy.js'

describe('trader strategy registry', () => {
  let cwd: string
  let tempDir: string

  beforeEach(async () => {
    cwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'oa-trader-strategy-'))
    process.chdir(tempDir)
    await mkdir(join(tempDir, 'data/strategies'), { recursive: true })
    await writeFile(join(tempDir, 'data/strategies/momentum.yml'), `
id: momentum
label: Momentum
enabled: true
sources: [ccxt-main, alpaca-paper]
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

  it('loads strategy yaml files from data/strategies', async () => {
    const strategies = await loadTraderStrategies()
    expect(strategies).toHaveLength(1)
    expect(strategies[0]).toMatchObject({
      id: 'momentum',
      label: 'Momentum',
      sources: ['ccxt-main', 'alpaca-paper'],
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
        sources: ['ccxt-main', 'alpaca-paper'],
        asset: 'crypto',
        symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      },
    ])
  })
})
