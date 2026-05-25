import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OhlcvBar, OhlcvCacheMeta, OhlcvPartitionKey, OhlcvRange } from './types.js'

export interface OhlcvCacheStoreOptions {
  rootDir?: string
  now?: () => Date
}

export class OhlcvCacheStore {
  private readonly rootDir: string
  private readonly now: () => Date

  constructor(options: OhlcvCacheStoreOptions = {}) {
    this.rootDir = options.rootDir ?? 'data/cache/ohlcv'
    this.now = options.now ?? (() => new Date())
  }

  async read(key: OhlcvPartitionKey, range: OhlcvRange = {}): Promise<OhlcvBar[]> {
    const bars = await this.readAll(key)
    return filterRange(bars, range)
  }

  async readAll(key: OhlcvPartitionKey): Promise<OhlcvBar[]> {
    try {
      const raw = await readFile(this.barsPath(key), 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return normalizeBars(parsed as Record<string, unknown>[])
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
  }

  async writeMerged(key: OhlcvPartitionKey, incoming: OhlcvBar[]): Promise<OhlcvBar[]> {
    const existing = await this.readAll(key)
    const merged = mergeBars(existing, incoming)
    await this.writeAll(key, merged)
    return merged
  }

  async writeAll(key: OhlcvPartitionKey, bars: OhlcvBar[]): Promise<void> {
    const normalized = normalizeBars(bars)
    const dir = this.partitionDir(key)
    await mkdir(dir, { recursive: true })
    await atomicWriteJson(this.barsPath(key), normalized)

    const meta: OhlcvCacheMeta = {
      ...key,
      from: normalized[0]?.date ?? '',
      to: normalized.at(-1)?.date ?? '',
      bars: normalized.length,
      updatedAt: this.now().toISOString(),
    }
    await atomicWriteJson(this.metaPath(key), meta)
  }

  async readMeta(key: OhlcvPartitionKey): Promise<OhlcvCacheMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(key), 'utf-8')) as OhlcvCacheMeta
    } catch (error) {
      if (isENOENT(error)) return null
      throw error
    }
  }

  private partitionDir(key: OhlcvPartitionKey): string {
    return join(
      this.rootDir,
      safeSegment(key.provider),
      safeSegment(key.asset),
      safeSegment(key.symbol),
      safeSegment(key.interval),
    )
  }

  private barsPath(key: OhlcvPartitionKey): string {
    return join(this.partitionDir(key), 'bars.json')
  }

  private metaPath(key: OhlcvPartitionKey): string {
    return join(this.partitionDir(key), 'meta.json')
  }
}

export function mergeBars(existing: OhlcvBar[], incoming: OhlcvBar[]): OhlcvBar[] {
  return normalizeBars([...existing, ...incoming])
}

export function filterRange(bars: OhlcvBar[], range: OhlcvRange): OhlcvBar[] {
  const start = range.startDate ?? null
  const end = range.endDate ?? null
  return bars.filter((bar) =>
    (!start || bar.date >= start) &&
    (!end || bar.date <= end)
  )
}

export function normalizeBars(rows: Record<string, unknown>[]): OhlcvBar[] {
  const byDate = new Map<string, OhlcvBar>()
  for (const row of rows) {
    const bar = normalizeBar(row)
    if (bar) byDate.set(bar.date, bar)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function normalizeBar(row: Record<string, unknown>): OhlcvBar | null {
  const date = typeof row.date === 'string' ? row.date : ''
  const open = toNumber(row.open)
  const high = toNumber(row.high)
  const low = toNumber(row.low)
  const close = toNumber(row.close)
  if (!date || open == null || high == null || low == null || close == null) return null

  return {
    ...row,
    date,
    open,
    high,
    low,
    close,
    volume: toNumber(row.volume),
    vwap: toNumber(row.vwap),
  }
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.=-]+/g, '_') || '_'
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(tmp, path)
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
