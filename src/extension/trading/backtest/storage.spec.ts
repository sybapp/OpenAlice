import { describe, it, expect } from 'vitest'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBacktestStorage } from './storage.js'
import { readFile, writeFile } from 'node:fs/promises'

function tempDir(name: string) {
  return join(tmpdir(), `backtest-storage-${name}-${randomUUID()}`)
}

describe('createBacktestStorage', () => {
  it('persists and reads run artifacts', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('artifacts') })
    const runId = 'run-1'

    await storage.createRun({
      runId,
      status: 'queued',
      mode: 'scripted',
      createdAt: '2025-01-01T00:00:00.000Z',
      artifactDir: storage.getRunPaths(runId).runDir,
      barCount: 3,
      currentStep: 0,
      accountId: 'paper-1',
      accountLabel: 'Paper 1',
      initialCash: 10_000,
      guards: [],
    })

    await storage.updateManifest(runId, { status: 'running', currentStep: 2 })
    await storage.appendEquityPoint(runId, {
      step: 1,
      ts: '2025-01-01T09:30:00.000Z',
      equity: 10_000,
      realizedPnL: 0,
      unrealizedPnL: 0,
    })
    await storage.writeSummary(runId, {
      runId,
      startEquity: 10_000,
      endEquity: 10_100,
      totalReturn: 0.01,
      realizedPnL: 100,
      unrealizedPnL: 0,
      maxDrawdown: 0,
      tradeCount: 1,
      winRate: 1,
      guardRejectionCount: 0,
    })
    await storage.writeGitState(runId, { commits: [], head: null })

    const manifest = await storage.getManifest(runId)
    const summary = await storage.readSummary(runId)
    const curve = await storage.readEquityCurve(runId)
    const git = await storage.readGitState(runId)

    expect(manifest?.status).toBe('running')
    expect(manifest?.currentStep).toBe(2)
    expect(summary?.endEquity).toBe(10_100)
    expect(curve).toHaveLength(1)
    expect(git).toEqual({ commits: [], head: null })
  })

  it('rejects unsafe runIds and keeps resolved paths inside the storage root', async () => {
    const rootDir = tempDir('safe-paths')
    const storage = createBacktestStorage({ rootDir })

    const safePaths = storage.getRunPaths('run_safe-1')
    expect(relative(rootDir, safePaths.runDir).startsWith('..')).toBe(false)

    expect(() => storage.getRunPaths('../escape')).toThrow('Invalid backtest runId:')
    expect(() => storage.getRunPaths('/tmp/escape')).toThrow('Invalid backtest runId:')
    expect(() => storage.getRunPaths('a/b')).toThrow('Invalid backtest runId:')
    expect(() => storage.getRunPaths('..')).toThrow('Invalid backtest runId:')
  })

  it('lists runs newest first', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('list') })

    await storage.createRun({
      runId: 'older',
      status: 'completed',
      mode: 'scripted',
      createdAt: '2025-01-01T00:00:00.000Z',
      artifactDir: storage.getRunPaths('older').runDir,
      barCount: 1,
      currentStep: 1,
      accountId: 'a',
      accountLabel: 'A',
      initialCash: 1_000,
      guards: [],
    })
    await storage.createRun({
      runId: 'newer',
      status: 'completed',
      mode: 'scripted',
      createdAt: '2025-01-02T00:00:00.000Z',
      artifactDir: storage.getRunPaths('newer').runDir,
      barCount: 1,
      currentStep: 1,
      accountId: 'b',
      accountLabel: 'B',
      initialCash: 1_000,
      guards: [],
    })

    const runs = await storage.listRuns()
    expect(runs.map((run) => run.runId)).toEqual(['newer', 'older'])
  })

  it('reads only the tail of the equity curve when limit is provided', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('equity-limit') })
    const runId = 'run-tail'

    await storage.createRun({
      runId,
      status: 'completed',
      mode: 'scripted',
      createdAt: '2025-01-01T00:00:00.000Z',
      artifactDir: storage.getRunPaths(runId).runDir,
      barCount: 5,
      currentStep: 5,
      accountId: 'paper-1',
      accountLabel: 'Paper 1',
      initialCash: 10_000,
      guards: [],
    })

    for (let step = 1; step <= 5; step += 1) {
      await storage.appendEquityPoint(runId, {
        step,
        ts: `2025-01-01T09:3${step}:00.000Z`,
        equity: 10_000 + step,
        realizedPnL: step,
        unrealizedPnL: 0,
      })
    }

    const points = await storage.readEquityCurve(runId, { limit: 2 })
    expect(points.map((point) => point.step)).toEqual([4, 5])
  })

  it('streams filtered event entries without reading unrelated history into the result', async () => {
    const storage = createBacktestStorage({ rootDir: tempDir('event-filter') })
    const runId = 'run-events'
    const paths = storage.getRunPaths(runId)

    await storage.createRun({
      runId,
      status: 'completed',
      mode: 'scripted',
      createdAt: '2025-01-01T00:00:00.000Z',
      artifactDir: paths.runDir,
      barCount: 3,
      currentStep: 3,
      accountId: 'paper-1',
      accountLabel: 'Paper 1',
      initialCash: 10_000,
      guards: [],
    })

    const lines = [
      { seq: 1, ts: 1, type: 'backtest.run.started', payload: { step: 0 } },
      { seq: 2, ts: 2, type: 'backtest.run.step', payload: { step: 1 } },
      { seq: 3, ts: 3, type: 'backtest.run.step', payload: { step: 2 } },
      { seq: 4, ts: 4, type: 'backtest.run.completed', payload: { step: 3 } },
    ]
    const raw = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    await writeFile(paths.eventLogPath, raw, 'utf-8')

    const entries = await storage.readEventEntries(runId, {
      afterSeq: 1,
      type: 'backtest.run.step',
      limit: 1,
    })

    expect(entries).toEqual([
      { seq: 2, ts: 2, type: 'backtest.run.step', payload: { step: 1 } },
    ])
  })

  it('maintains a run index so listRuns does not need to rebuild from directories every time', async () => {
    const rootDir = tempDir('run-index')
    const storage = createBacktestStorage({ rootDir })

    await storage.createRun({
      runId: 'indexed',
      status: 'queued',
      mode: 'scripted',
      createdAt: '2025-01-03T00:00:00.000Z',
      artifactDir: storage.getRunPaths('indexed').runDir,
      barCount: 1,
      currentStep: 0,
      accountId: 'paper-1',
      accountLabel: 'Paper 1',
      initialCash: 10_000,
      guards: [],
    })
    await storage.updateManifest('indexed', { status: 'completed', currentStep: 1 })

    const indexPath = join(rootDir, 'runs-index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf-8')) as Array<{ runId: string; status: string; currentStep: number }>
    expect(index).toHaveLength(1)
    expect(index[0]).toMatchObject({ runId: 'indexed', status: 'completed', currentStep: 1 })

    const runs = await storage.listRuns()
    expect(runs[0]).toMatchObject({ runId: 'indexed', status: 'completed', currentStep: 1 })
  })
})
