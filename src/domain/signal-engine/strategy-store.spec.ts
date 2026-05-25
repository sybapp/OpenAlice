import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hashSignalEngineStrategyManifest,
  SignalEngineStrategyStore,
} from './strategy-store.js'

describe('SignalEngineStrategyStore', () => {
  let root: string
  let path: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-signal-strategy-store-'))
    path = join(root, 'strategies.json')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('seeds missing file once and keeps existing file untouched', async () => {
    const store = new SignalEngineStrategyStore(path)
    const manifest = { kind: 'builtin', family: 'structure-volume-price' }
    const pluginHash = hashSignalEngineStrategyManifest(manifest)
    const seeded = await store.seedIfMissing([{
      id: 'structure-volume-price',
      version: '1',
      manifest,
      pluginHash,
    }])
    expect(seeded).toBe(true)
    expect(await store.get('structure-volume-price', '1')).toMatchObject({ pluginHash })

    await writeFile(path, '[]\n', 'utf-8')
    const reseeded = await store.seedIfMissing([{
      id: 'structure-volume-price',
      version: '1',
      manifest,
      pluginHash,
    }])
    expect(reseeded).toBe(false)
    expect(await store.get('structure-volume-price', '1')).toBeNull()
  })
})
