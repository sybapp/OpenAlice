import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarketDataAlertRunStore } from './run-store.js'

describe('MarketDataAlertRunStore', () => {
  let tempDir: string
  let store: MarketDataAlertRunStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openalice-alert-runs-'))
    store = new MarketDataAlertRunStore(join(tempDir, 'runs.jsonl'), join(tempDir, 'feedback.json'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty results when files do not exist', async () => {
    await expect(store.list()).resolves.toEqual({ count: 0, entries: [] })
  })

  it('appends, filters, and limits run records', async () => {
    await store.append([
      {
        startedAt: '2026-05-08T01:00:00.000Z',
        finishedAt: '2026-05-08T01:00:01.000Z',
        asset: 'equity',
        symbol: 'QQQ',
        interval: '5m',
        mode: 'deterministic',
        status: 'triggered',
        signals: [{ id: 'volume:x', kind: 'volume', label: 'absorption', index: 1, time: 't', message: 'absorption' }],
        notified: true,
        taskRequested: false,
        summary: 'QQQ triggered',
      },
      {
        startedAt: '2026-05-08T02:00:00.000Z',
        finishedAt: '2026-05-08T02:00:01.000Z',
        asset: 'crypto',
        symbol: 'BTCUSD',
        interval: '1h',
        mode: 'agent',
        status: 'skipped',
        skipped: true,
        reason: 'no_new_signals',
        signals: [],
        notified: false,
        taskRequested: false,
        summary: 'BTC skipped',
      },
    ])

    const result = await store.list({ asset: 'equity', limit: 10 })

    expect(result.count).toBe(1)
    expect(result.entries[0]).toMatchObject({ symbol: 'QQQ', status: 'triggered', signals: [{ id: 'volume:x' }] })
  })

  it('records feedback and joins it into list results', async () => {
    const [record] = await store.append([{
      startedAt: '2026-05-08T01:00:00.000Z',
      finishedAt: '2026-05-08T01:00:01.000Z',
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      mode: 'both',
      status: 'triggered',
      signals: [],
      notified: true,
      taskRequested: true,
      summary: 'QQQ triggered',
    }])

    const feedback = await store.recordFeedback({
      runId: record.runId,
      rating: 'false_positive',
      note: 'too small',
      now: () => new Date('2026-05-08T03:00:00.000Z'),
    })
    const listed = await store.list()

    expect(feedback).toEqual({
      ok: true,
      runId: record.runId,
      feedback: { rating: 'false_positive', note: 'too small', updatedAt: '2026-05-08T03:00:00.000Z' },
    })
    expect(listed.entries[0].feedback).toMatchObject({ rating: 'false_positive', note: 'too small' })
  })

  it('rejects feedback for unknown runs', async () => {
    await expect(store.recordFeedback({ runId: 'missing', rating: 'ignored' }))
      .resolves.toEqual({ ok: false, error: 'Unknown alert run: missing' })
  })
})
