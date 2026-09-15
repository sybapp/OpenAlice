import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger.js'
import { WatchRuntimeStore } from './watch-state.js'

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  event() {},
  child() {
    return noopLogger
  },
} as unknown as Logger

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'watch-state-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WatchRuntimeStore', () => {
  it('round-trips check/trigger memory and reloads it after restart', async () => {
    const path = join(dir, 'watch-state.json')
    const first = await WatchRuntimeStore.load(path, noopLogger)
    expect(first.get('w1', 'i1')).toBeUndefined()
    await first.set('w1', 'i1', {
      watchVersion: 2,
      lastCheckedAt: 100,
      lastTriggeredAt: 90,
      lastStatus: 'hit',
      lastEvidence: { close: 195 },
      lastRunId: 'run-1',
      leafStates: { 0: { lastTriggeredAt: 90, consumedSignalIds: ['BOS|swing|bullish|2024-01-02|2024-01-01|190|192'] } },
    })

    const second = await WatchRuntimeStore.load(path, noopLogger)
    expect(second.get('w1', 'i1')).toEqual({
      watchVersion: 2,
      lastCheckedAt: 100,
      lastTriggeredAt: 90,
      lastStatus: 'hit',
      lastEvidence: { close: 195 },
      lastRunId: 'run-1',
      leafStates: { 0: { lastTriggeredAt: 90, consumedSignalIds: ['BOS|swing|bullish|2024-01-02|2024-01-01|190|192'] } },
    })
  })

  it('ignores unknown fields (including the retired flat consumedSignalIds) on load', async () => {
    const path = join(dir, 'watch-state.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      states: {
        'w1 i1': {
          watchVersion: 1,
          lastCheckedAt: 50,
          lastTriggeredAt: 40,
          lastStatus: 'hit',
          consumedSignalIds: ['old-sig-1', 'old-sig-2'],
          lastRunId: 'run-1',
        },
      },
    }), 'utf8')
    const store = await WatchRuntimeStore.load(path, noopLogger)
    // Unshipped branch-only shape: no dual-read, no seed — the flat ids are
    // dropped and the per-leaf latch starts clean.
    expect(store.get('w1', 'i1')).toMatchObject({
      watchVersion: 1,
      lastTriggeredAt: 40,
    })
    expect(store.get('w1', 'i1')?.leafStates).toBeUndefined()
  })

  it('round-trips independent per-leaf latches', async () => {
    const path = join(dir, 'watch-state.json')
    const store = await WatchRuntimeStore.load(path, noopLogger)
    await store.set('w1', 'i1', {
      watchVersion: 1,
      lastCheckedAt: 10,
      lastTriggeredAt: 20,
      lastStatus: 'hit',
      leafStates: {
        0: { lastTriggeredAt: 20 },
        1: { consumedSignalIds: ['BOS|swing|bullish|d2|d1|190|192'] },
      },
    })
    const reloaded = await WatchRuntimeStore.load(path, noopLogger)
    expect(reloaded.get('w1', 'i1')?.leafStates).toEqual({
      0: { lastTriggeredAt: 20 },
      1: { consumedSignalIds: ['BOS|swing|bullish|d2|d1|190|192'] },
    })
  })

  it('prunes keys no longer declared', async () => {
    const path = join(dir, 'watch-state.json')
    const store = await WatchRuntimeStore.load(path, noopLogger)
    await store.set('w1', 'gone', { watchVersion: 1, lastCheckedAt: 1 })
    await store.set('w1', 'kept', { watchVersion: 1, lastCheckedAt: 1 })
    await store.prune(new Set([store.key('w1', 'kept')]))
    expect(store.get('w1', 'gone')).toBeUndefined()
    expect(store.get('w1', 'kept')).toBeDefined()
  })

  it('drops corrupt rows and starts clean on a missing file', async () => {
    const store = await WatchRuntimeStore.load(join(dir, 'absent.json'), noopLogger)
    expect(store.get('w', 'i')).toBeUndefined()
    expect(store.key('w', 'i')).toBe('w i')
    expect(vi.fn()).toBeDefined()
  })
})
