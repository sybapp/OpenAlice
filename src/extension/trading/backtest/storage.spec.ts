import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBacktestStorage } from './storage.js'

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
})
