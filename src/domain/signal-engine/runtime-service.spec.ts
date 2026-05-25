import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { SignalEngineConfig } from '../../core/config.js'
import { OhlcvCacheStore } from '../market-data/ohlcv/index.js'
import { SignalEngineArtifactStore } from './artifact-store.js'
import { createSignalEngineService } from './runtime-service.js'
import { SignalEngineStrategyStore } from './strategy-store.js'

let root: string
let cacheRoot: string
let artifactRoot: string
let cacheStore: OhlcvCacheStore

describe('SignalEngineService', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-signal-runtime-'))
    cacheRoot = join(root, 'cache')
    artifactRoot = join(root, 'signal-engine')
    cacheStore = new OhlcvCacheStore({ rootDir: cacheRoot })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs configured strategy from closed OHLCV cache bars and writes artifact', async () => {
    await cacheStore.writeAll(key(), bars())
    const service = createSignalEngineService({
      config: config(),
      ohlcvCacheStore: cacheStore,
      artifactStore: new SignalEngineArtifactStore(artifactRoot),
    })

    const result = await service.run({
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      provider: 'fixture',
      strategyId: 'structure-volume-price',
      strategyVersion: '1',
      riskTemplateId: 'missing-risk',
      riskTemplateVersion: '1',
      lookbackBars: 20,
    })

    expect(result.record.runId).toBe(result.output.runId)
    expect(result.output.signals.length).toBeGreaterThan(0)
    expect(result.output.closedBarsOnly).toBe(true)
    const strategies = await new SignalEngineStrategyStore(join(root, 'strategies.json')).list()
    expect(strategies.count).toBeGreaterThan(0)

    const artifact = await new SignalEngineArtifactStore(artifactRoot).getArtifact(result.record.runId)
    expect(artifact?.input).toMatchObject({
      symbol: 'QQQ',
      provider: 'fixture',
      strategyId: 'structure-volume-price',
      riskTemplate: {
        id: 'missing-risk',
        version: '1',
        stopLossBps: '100',
      },
    })
    expect(result.record.metadata).toMatchObject({
      riskTemplateFallback: true,
      requestedRiskTemplateId: 'missing-risk',
      fallbackRiskTemplateId: 'safe-default',
    })
    expect(artifact?.manifest.metadata).toMatchObject({
      riskTemplateFallback: true,
      requestedRiskTemplateId: 'missing-risk',
      fallbackRiskTemplateId: 'safe-default',
    })
  })

  it('replays from artifact input instead of current cache bars', async () => {
    await cacheStore.writeAll(key(), bars())
    const artifactStore = new SignalEngineArtifactStore(artifactRoot)
    const service = createSignalEngineService({
      config: config(),
      ohlcvCacheStore: cacheStore,
      artifactStore,
    })
    const original = await service.run(config().items[0])

    await cacheStore.writeAll(key(), bars().slice(0, 4))
    const replay = await service.replay(original.record.runId)

    expect(replay.record.replayOfRunId).toBe(original.record.runId)
    expect(replay.output.inputHash).toBe(original.output.inputHash)
    expect(replay.output.outputHash).toBe(original.output.outputHash)
    expect(replay.output.signals).toEqual(original.output.signals)
  })

  it('skips disabled configured items during runOnce', async () => {
    await cacheStore.writeAll(key(), bars())
    const next = config()
    next.items = [
      { ...next.items[0], enabled: false, symbol: 'OFF' },
      { ...next.items[0], enabled: true },
    ]
    const service = createSignalEngineService({
      config: next,
      ohlcvCacheStore: cacheStore,
      artifactStore: new SignalEngineArtifactStore(artifactRoot),
    })

    const result = await service.runOnce()

    expect(result.itemCount).toBe(2)
    expect(result.results).toHaveLength(1)
    expect(result.errors).toHaveLength(0)
    expect(result.results[0].symbol).toBe('QQQ')
  })

  it('fails when strategy registry file exists but strategy is missing', async () => {
    await cacheStore.writeAll(key(), bars())
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(join(root, 'strategies.json'), '[]\n', 'utf-8')
    const service = createSignalEngineService({
      config: config(),
      ohlcvCacheStore: cacheStore,
      artifactStore: new SignalEngineArtifactStore(artifactRoot),
    })

    await expect(service.run(config().items[0])).rejects.toThrow('Signal engine strategy is not registered: structure-volume-price@1')
  })

  it('fails when registered strategy hash mismatches built-in plugin hash', async () => {
    await cacheStore.writeAll(key(), bars())
    const strategyStore = new SignalEngineStrategyStore(join(root, 'strategies.json'))
    await strategyStore.upsert({
      id: 'structure-volume-price',
      version: '1',
      manifest: { kind: 'builtin', family: 'tampered' },
      pluginHash: 'deadbeef',
    })
    const service = createSignalEngineService({
      config: config(),
      ohlcvCacheStore: cacheStore,
      artifactStore: new SignalEngineArtifactStore(artifactRoot),
      strategyStore,
    })

    await expect(service.run(config().items[0])).rejects.toThrow('Signal engine strategy hash mismatch for structure-volume-price@1')
  })
})

function key() {
  return {
    asset: 'equity' as const,
    symbol: 'QQQ',
    interval: '5m',
    provider: 'fixture',
  }
}

function config(): SignalEngineConfig {
  return {
    enabled: true,
    dir: artifactRoot,
    every: '5m',
    strategiesPath: join(root, 'strategies.json'),
    riskTemplatesPath: join(root, 'risk-templates.jsonl'),
    closedBarsOnly: true,
    autoStage: {
      enabled: false,
      allowedUtaModes: ['simulator', 'paper'],
      neverPush: true,
    },
    defaults: {
      orderType: 'LMT',
      requireStopLoss: true,
    },
    items: [{
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      provider: 'fixture',
      strategyId: 'structure-volume-price',
      strategyVersion: '1',
      riskTemplateId: 'missing-risk',
      riskTemplateVersion: '1',
      lookbackBars: 20,
    }],
  }
}

function bars() {
  return [
    bar(0, 10, 11, 9, 10, 1000),
    bar(1, 10, 12, 9, 11, 1050),
    bar(2, 11, 13, 10, 12, 1000),
    bar(3, 12, 13, 11, 12, 950),
    bar(4, 12, 13, 10, 11, 900),
    bar(5, 11, 12, 9, 10, 950),
    bar(6, 10, 11, 9, 10, 1000),
    bar(7, 10, 15, 10, 15, 2200),
  ]
}

function bar(index: number, open: number, high: number, low: number, close: number, volume: number) {
  return {
    date: `2026-05-08T00:${String(index).padStart(2, '0')}:00.000Z`,
    open,
    high,
    low,
    close,
    volume,
    closed: true,
  }
}
