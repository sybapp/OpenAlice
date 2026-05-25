import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ListTradeSetupsOptions, TradeSetup } from './setup-types.js'

export const DEFAULT_TRADE_SETUP_PATH = 'data/trading/setups/setups.json'

let defaultTradeSetupPath = DEFAULT_TRADE_SETUP_PATH

export class TradeSetupStore {
  constructor(private readonly path = defaultTradeSetupPath) {}

  async list(options: ListTradeSetupsOptions = {}) {
    const limit = clampLimit(options.limit)
    const setups = (await this.readAll())
      .filter((setup) => !options.status || setup.status === options.status)
      .filter((setup) => !options.symbol || setup.symbol.toUpperCase() === options.symbol.toUpperCase())
      .filter((setup) => !options.source || setup.order.source === options.source)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)

    return { count: setups.length, entries: setups }
  }

  async get(setupId: string): Promise<TradeSetup | null> {
    return (await this.readAll()).find((setup) => setup.setupId === setupId) ?? null
  }

  async create(input: Omit<TradeSetup, 'setupId' | 'status' | 'createdAt' | 'updatedAt'> & { setupId?: string }): Promise<TradeSetup> {
    const now = new Date().toISOString()
    const setup: TradeSetup = {
      ...input,
      setupId: input.setupId ?? randomUUID(),
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }
    await this.writeAll([setup, ...await this.readAll()])
    return setup
  }

  async update(setupId: string, patch: Partial<Omit<TradeSetup, 'setupId' | 'createdAt'>>): Promise<TradeSetup | null> {
    const setups = await this.readAll()
    const index = setups.findIndex((setup) => setup.setupId === setupId)
    if (index < 0) return null
    setups[index] = {
      ...setups[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await this.writeAll(setups)
    return setups[index]
  }

  private async readAll(): Promise<TradeSetup[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf-8')) as unknown
      return Array.isArray(parsed) ? parsed.filter(isSetup) : []
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
  }

  private async writeAll(setups: TradeSetup[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(setups, null, 2) + '\n', 'utf-8')
    await rename(tmp, this.path)
  }
}

export async function listTradeSetups(options: ListTradeSetupsOptions & { path?: string } = {}) {
  return await new TradeSetupStore(options.path).list(options)
}

export function setTradeSetupStoreDefaultPath(path?: string): void {
  defaultTradeSetupPath = path ?? DEFAULT_TRADE_SETUP_PATH
}

function isSetup(value: unknown): value is TradeSetup {
  return Boolean(value && typeof value === 'object' && typeof (value as { setupId?: unknown }).setupId === 'string')
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 100
  return Math.max(1, Math.min(500, Math.trunc(limit)))
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
