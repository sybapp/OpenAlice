import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { sha256Hex } from './canonical-json.js'
import { SignalEngineArtifactStore } from './artifact-store.js'

describe('SignalEngineArtifactStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-signal-artifacts-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes canonical artifacts and records hashes from file bytes', async () => {
    const store = new SignalEngineArtifactStore(root)
    const run = await store.appendRun({
      status: 'completed',
      strategyId: 'structure-volume-price',
      strategyVersion: '1',
      symbol: 'QQQ',
      interval: '5m',
      input: { b: 2, a: 1 },
      output: { signals: [] },
      events: [{ z: 1, a: 2 }],
      now: () => new Date('2026-05-08T00:00:00.000Z'),
    })

    const artifact = await store.getArtifact(run.runId)
    expect(artifact).not.toBeNull()
    if (!artifact) return

    for (const [file, hash] of Object.entries(artifact.hashes)) {
      const bytes = await readFile(join(artifact.artifactDir, file))
      expect(hash).toBe(sha256Hex(bytes))
    }
    expect(run.inputHash).toBe(artifact.hashes['input.canonical.json'])
    expect((await store.listRuns({ symbol: 'qqq' })).entries[0].runId).toBe(run.runId)
  })
})
