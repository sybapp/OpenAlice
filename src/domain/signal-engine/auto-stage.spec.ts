import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UTAConfig } from '../../core/config.js'
import { TradeSetupService } from '../trading/setup-service.js'
import { TradeSetupStore } from '../trading/setup-store.js'
import { autoStageSignalRun } from './auto-stage.js'
import type { RiskTemplate, SignalEngineRun, SignalEngineSignal } from './types.js'

describe('autoStageSignalRun', () => {
  let root: string
  let setupStore: TradeSetupStore
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-signal-auto-stage-'))
    setupStore = new TradeSetupStore(join(root, 'setups.json'))
    calls = []
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function tradeSetupService(accounts: UTAConfig[] = [simAccount()]) {
    return new TradeSetupService({
      setupStore,
      readUTAsConfig: async () => accounts,
      utaManager: {
        resolveOne: vi.fn(() => ({
          stagePlaceOrder: vi.fn(() => { calls.push('stagePlaceOrder') }),
          commit: vi.fn((message: string) => {
            calls.push(`commit:${message}`)
            return { prepared: true, hash: 'commit123', message, operationCount: 1 }
          }),
          push: vi.fn(() => { calls.push('push') }),
        })),
      } as never,
    })
  }

  it('creates and stages signal setups without pushing', async () => {
    const result = await autoStageSignalRun({
      run: signalRun(),
      config: autoStageConfig('sim-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService(),
      resolveAliceId: async () => 'sim-uta|canonical-QQQ',
    })

    expect(result.autoStageStatus).toBe('staged')
    expect(result.autoStage).toMatchObject({ attempted: 1, staged: 1, failed: 0 })
    expect(calls[0]).toBe('stagePlaceOrder')
    expect(calls[1]).toContain('requires manual push')
    expect(calls).not.toContain('push')

    const setups = await setupStore.list()
    expect(setups.entries[0]).toMatchObject({
      status: 'committed',
      source: {
        type: 'signal_engine',
        signalRunId: 'sr_test',
        signalId: 'sig_test',
        dataFingerprint: 'data_hash',
        closedBarTime: '2026-05-11T01:00:00.000Z',
      },
      provenance: {
        sourceHash: 'source_hash',
        canonicalPayloadHash: 'payload_hash',
        riskTemplateId: 'risk-default',
        riskTemplateVersion: '1',
      },
      order: {
        aliceId: 'sim-uta|canonical-QQQ',
      },
    })
  })

  it('records auto-stage status instead of throwing when defaultUtaId is missing or there are no signals', async () => {
    const missingUta = await autoStageSignalRun({
      run: signalRun(),
      config: autoStageConfig(undefined),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService(),
      resolveAliceId: async () => 'sim-uta|canonical-QQQ',
    })
    const noSignals = await autoStageSignalRun({
      run: { ...signalRun(), signals: [] },
      config: autoStageConfig('sim-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService(),
      resolveAliceId: async () => 'sim-uta|canonical-QQQ',
    })

    expect(missingUta).toMatchObject({
      autoStageStatus: 'skipped',
      autoStageError: 'signalEngine.autoStage.defaultUtaId is required',
    })
    expect(noSignals).toMatchObject({
      autoStageStatus: 'skipped',
      autoStageError: 'no signals to auto-stage',
    })
    expect(calls).toEqual([])
  })

  it('refuses real and unknown accounts through the stage-time signal gate', async () => {
    const real = await autoStageSignalRun({
      run: signalRun(),
      config: autoStageConfig('real-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService([realAccount()]),
      resolveAliceId: async () => 'real-uta|canonical-QQQ',
    })
    const unknown = await autoStageSignalRun({
      run: signalRun(),
      config: autoStageConfig('missing-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService([]),
      resolveAliceId: async () => 'missing-uta|canonical-QQQ',
    })

    expect(real.autoStageStatus).toBe('failed')
    expect(real.autoStageError).toBe('Signal setup account mode is not allowed: real')
    expect(unknown.autoStageStatus).toBe('failed')
    expect(unknown.autoStageError).toBe('Signal setup account is unknown: missing-uta')
    expect(calls).toEqual([])
  })

  it('requires tradeable LMT signals with stop loss before creating setups', async () => {
    const marketOrder = await autoStageSignalRun({
      run: signalRun({ order: { ...signal().order, orderType: 'MKT' as 'LMT' } }),
      config: autoStageConfig('sim-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService(),
      resolveAliceId: async () => 'sim-uta|canonical-QQQ',
    })
    const missingStop = await autoStageSignalRun({
      run: signalRun({ order: { ...signal().order, stopLoss: undefined as never } }),
      config: autoStageConfig('sim-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService(),
      resolveAliceId: async () => 'sim-uta|canonical-QQQ',
    })

    expect(marketOrder).toMatchObject({ autoStageStatus: 'failed', autoStageError: 'signal is not tradeable' })
    expect(missingStop).toMatchObject({ autoStageStatus: 'failed', autoStageError: 'signal is not tradeable' })
    expect(await setupStore.list()).toMatchObject({ count: 0 })
    expect(calls).toEqual([])
  })

  it('fails before setup creation when no canonical tradeable aliceId is resolved', async () => {
    const result = await autoStageSignalRun({
      run: signalRun(),
      config: autoStageConfig('sim-uta'),
      riskTemplate: riskTemplate(),
      tradeSetupService: tradeSetupService(),
      resolveAliceId: async () => null,
    })

    expect(result).toMatchObject({
      autoStageStatus: 'failed',
      autoStageError: 'No tradeable contract found for sim-uta:QQQ',
    })
    expect(await setupStore.list()).toMatchObject({ count: 0 })
    expect(calls).toEqual([])
  })
})

function autoStageConfig(defaultUtaId: string | undefined) {
  return {
    autoStage: {
      enabled: true,
      ...(defaultUtaId ? { defaultUtaId } : {}),
      allowedUtaModes: ['simulator', 'paper'] as Array<'simulator' | 'paper'>,
      neverPush: true as const,
    },
  }
}

function signalRun(overrides: Partial<SignalEngineSignal> = {}): SignalEngineRun {
  return {
    runId: 'sr_test',
    engineVersion: '1',
    status: 'completed',
    startedAt: '2026-05-11T01:00:00.000Z',
    finishedAt: '2026-05-11T01:00:00.000Z',
    asset: 'equity',
    symbol: 'QQQ',
    interval: '5m',
    provider: 'fixture',
    strategyId: 'structure-volume-price',
    strategyVersion: '1',
    riskTemplateId: 'risk-default',
    riskTemplateVersion: '1',
    closedBarsOnly: true,
    dataFingerprint: 'data_hash',
    inputHash: 'input_hash',
    outputHash: 'output_hash',
    signals: [signal(overrides)],
    summary: '1 signal',
  }
}

function signal(overrides: Partial<SignalEngineSignal> = {}): SignalEngineSignal {
  return {
    id: 'sig_test',
    kind: 'structure_volume_price',
    label: 'bullish BOS volume-price',
    message: 'QQQ 5m bullish structure break.',
    direction: 'bullish',
    closedBarTime: '2026-05-11T01:00:00.000Z',
    index: 12,
    lmtPrice: '430',
    stopLoss: { price: '420' },
    takeProfit: { price: '450' },
    order: {
      orderType: 'LMT',
      action: 'BUY',
      lmtPrice: '430',
      stopLoss: { price: '420' },
      takeProfit: { price: '450' },
    },
    features: {
      volumeScore: '1.5',
      vwap: '428',
    },
    sourceHash: 'source_hash',
    canonicalPayloadHash: 'payload_hash',
    ...overrides,
  }
}

function riskTemplate(): RiskTemplate {
  return {
    id: 'risk-default',
    version: '1',
    totalQuantity: '1',
  }
}

function simAccount(): UTAConfig {
  return {
    id: 'sim-uta',
    presetId: 'mock-simulator',
    enabled: true,
    guards: [],
    presetConfig: {},
  }
}

function realAccount(): UTAConfig {
  return {
    id: 'real-uta',
    presetId: 'alpaca',
    enabled: true,
    guards: [],
    presetConfig: { mode: 'live', apiKey: 'key', apiSecret: 'secret' },
  }
}
