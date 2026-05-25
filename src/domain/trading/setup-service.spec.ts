import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketDataAlertRunStore } from '../market-data/ohlcv/run-store.js'
import { TradeSetupService } from './setup-service.js'
import { TradeSetupStore } from './setup-store.js'

describe('TradeSetupService', () => {
  let root: string
  let setupStore: TradeSetupStore
  let alertRunStore: MarketDataAlertRunStore
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-trade-setup-service-'))
    setupStore = new TradeSetupStore(join(root, 'setups.json'))
    alertRunStore = new MarketDataAlertRunStore(join(root, 'runs.jsonl'), join(root, 'feedback.json'))
    calls = []
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function service() {
    return new TradeSetupService({
      setupStore,
      alertRunStore,
      utaManager: {
        resolveOne: vi.fn(() => ({
          stagePlaceOrder: vi.fn(() => { calls.push('stagePlaceOrder') }),
          commit: vi.fn((message: string) => {
            calls.push(`commit:${message}`)
            return { prepared: true, hash: 'abc123', message, operationCount: 1 }
          }),
          push: vi.fn(() => { calls.push('push') }),
        })),
      } as never,
    })
  }

  async function appendAlertRun() {
    const [run] = await alertRunStore.append([{
      startedAt: '2026-05-08T00:00:00.000Z',
      finishedAt: '2026-05-08T00:00:01.000Z',
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      mode: 'deterministic',
      status: 'triggered',
      signals: [{ id: 'structure:1', kind: 'structure', label: 'internal BOS', direction: 'bullish', index: 10, time: 't', message: 'bullish BOS' }],
      notified: true,
      taskRequested: false,
      summary: 'QQQ triggered',
    }])
    return run
  }

  it('creates a draft setup from a triggered alert run', async () => {
    const run = await appendAlertRun()

    const result = await service().createFromAlertRun({
      alertRunId: run.runId,
      source: 'mock-uta',
      aliceId: 'mock-uta|QQQ',
      totalQuantity: '1',
      stopLossPrice: '420',
      invalidation: 'below bullish OB',
      takeProfitPrice: '440',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.setup).toMatchObject({
        status: 'draft',
        symbol: 'QQQ',
        direction: 'bullish',
        order: {
          source: 'mock-uta',
          aliceId: 'mock-uta|QQQ',
          action: 'BUY',
          orderType: 'MKT',
          totalQuantity: '1',
          stopLoss: { price: '420' },
          takeProfit: { price: '440' },
        },
      })
    }
  })

  it('stages and commits a setup without pushing', async () => {
    const run = await appendAlertRun()
    const created = await service().createFromAlertRun({
      alertRunId: run.runId,
      source: 'mock-uta',
      aliceId: 'mock-uta|QQQ',
      totalQuantity: '1',
      stopLossPrice: '420',
      invalidation: 'below bullish OB',
    })
    if (!created.ok) throw new Error(created.error)

    const result = await service().stageSetup(created.setup.setupId)

    expect(result.ok).toBe(true)
    expect(calls[0]).toBe('stagePlaceOrder')
    expect(calls[1]).toContain('commit:')
    expect(calls).not.toContain('push')
    if (result.ok) {
      expect(result.setup).toMatchObject({ status: 'committed', commitHash: 'abc123' })
      expect(result.setup.commitMessage).toContain('requires manual push')
    }
  })

  it('rejects missing stopLoss and invalidation before creating setup', async () => {
    const run = await appendAlertRun()

    const result = await service().createFromAlertRun({
      alertRunId: run.runId,
      source: 'mock-uta',
      aliceId: 'mock-uta|QQQ',
      totalQuantity: '1',
      invalidation: '',
    })

    expect(result).toEqual({ ok: false, error: 'invalidation is required' })
  })

  it('does not stage a committed setup twice', async () => {
    const run = await appendAlertRun()
    const svc = service()
    const created = await svc.createFromAlertRun({
      alertRunId: run.runId,
      source: 'mock-uta',
      aliceId: 'mock-uta|QQQ',
      totalQuantity: '1',
      stopLossPrice: '420',
      invalidation: 'below bullish OB',
    })
    if (!created.ok) throw new Error(created.error)
    await svc.stageSetup(created.setup.setupId)

    const second = await svc.stageSetup(created.setup.setupId)

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('Setup is already committed')
  })
})
