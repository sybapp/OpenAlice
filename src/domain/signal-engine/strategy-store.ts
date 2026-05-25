import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_SIGNAL_ENGINE_STRATEGIES_PATH = 'data/signal-engine/strategies.json'

export interface SignalEngineStrategyRecord {
  id: string
  version: string
  manifest: Record<string, unknown>
  pluginHash: string
  createdAt: string
  updatedAt: string
}

export interface UpsertSignalEngineStrategyInput {
  id: string
  version: string
  manifest: Record<string, unknown>
  pluginHash?: string
  now?: () => Date
}

export interface SeedSignalEngineStrategyInput {
  id: string
  version: string
  manifest: Record<string, unknown>
  pluginHash: string
}

export class SignalEngineStrategyStore {
  constructor(private readonly path = DEFAULT_SIGNAL_ENGINE_STRATEGIES_PATH) {}

  async list(): Promise<{ count: number; entries: SignalEngineStrategyRecord[] }> {
    const entries = await this.read()
    return {
      count: entries.length,
      entries: entries.sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version)),
    }
  }

  async get(id: string, version: string): Promise<SignalEngineStrategyRecord | null> {
    const entries = await this.read()
    return entries.find((entry) => entry.id === id && entry.version === version) ?? null
  }

  async upsert(input: UpsertSignalEngineStrategyInput): Promise<SignalEngineStrategyRecord> {
    const entries = await this.read()
    const now = (input.now?.() ?? new Date()).toISOString()
    const existingIndex = entries.findIndex((entry) => entry.id === input.id && entry.version === input.version)
    const existing = existingIndex >= 0 ? entries[existingIndex] : undefined
    const record: SignalEngineStrategyRecord = {
      id: input.id,
      version: input.version,
      manifest: input.manifest,
      pluginHash: input.pluginHash ?? hashSignalEngineStrategyManifest(input.manifest),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existingIndex >= 0) {
      entries[existingIndex] = record
    } else {
      entries.push(record)
    }
    await this.write(entries)
    return record
  }

  async seedIfMissing(entries: SeedSignalEngineStrategyInput[], now?: () => Date): Promise<boolean> {
    try {
      await readFile(this.path, 'utf-8')
      return false
    } catch (error) {
      if (!isENOENT(error)) throw error
    }

    const at = (now?.() ?? new Date()).toISOString()
    const seeded: SignalEngineStrategyRecord[] = entries.map((entry) => ({
      id: entry.id,
      version: entry.version,
      manifest: entry.manifest,
      pluginHash: entry.pluginHash,
      createdAt: at,
      updatedAt: at,
    }))
    await this.write(seeded)
    return true
  }

  private async read(): Promise<SignalEngineStrategyRecord[]> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf-8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw
        .map((value) => normalizeStrategy(value))
        .filter((value): value is SignalEngineStrategyRecord => value !== null)
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
  }

  private async write(entries: SignalEngineStrategyRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
    await rename(tmp, this.path)
  }
}

function normalizeStrategy(value: unknown): SignalEngineStrategyRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<SignalEngineStrategyRecord>
  if (!record.id || !record.version || !record.manifest || !record.pluginHash) return null
  return {
    id: record.id,
    version: record.version,
    manifest: record.manifest,
    pluginHash: record.pluginHash,
    createdAt: record.createdAt ?? new Date(0).toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
  }
}

export function hashSignalEngineStrategyManifest(manifest: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortJson(manifest))).digest('hex')
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
