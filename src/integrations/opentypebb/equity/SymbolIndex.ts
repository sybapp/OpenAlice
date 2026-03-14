/**
 * Equity Symbol Index — 本地正则搜索
 *
 * 为了让 AI 能用正则/关键词搜索 equity symbol，我们在启动时从
 * OpenTypeBB 已实现的 equity discovery endpoints 预热一批 symbol，
 * 并缓存到 runtime/cache/equity/symbols.json。
 *
 * 搜索在本地内存中进行，不依赖 API 的搜索能力。
 *
 * 注意：TypeScript 版 OpenTypeBB 当前并未注册 Python 侧的 sec/tmx
 * equity-search provider，所以这里不能再假设“全量 search provider”
 * 一定存在。我们改为基于当前 registry 中已实现的 discovery models
 * 构建一个“够用且稳定”的 symbol 索引。
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { createRegistry } from 'opentypebb'
import type { EquityClientLike } from '../sdk/types.js'
import { RUNTIME_CACHE_DIR } from '../../../core/paths.js'

// ==================== Types ====================

export interface SymbolEntry {
  symbol: string
  name: string
  source: string
  [key: string]: unknown
}

interface CacheEnvelope {
  cachedAt: string
  sources: string[]
  count: number
  entries: SymbolEntry[]
}

// ==================== Config ====================

const SUPPORTED_PROVIDERS = new Set(createRegistry().providers.keys())

const SOURCE_PLANS = [
  { provider: 'yfinance', method: 'getActive', limit: 200 },
  { provider: 'yfinance', method: 'getGainers', limit: 200 },
  { provider: 'yfinance', method: 'getLosers', limit: 200 },
  { provider: 'fmp', method: 'getActive', limit: 200 },
  { provider: 'fmp', method: 'getGainers', limit: 200 },
  { provider: 'fmp', method: 'getLosers', limit: 200 },
] as const

const CACHE_FILE = join(RUNTIME_CACHE_DIR, 'equity', 'symbols.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// ==================== SymbolIndex ====================

export class SymbolIndex {
  private entries: SymbolEntry[] = []

  /** 索引大小 */
  get size(): number {
    return this.entries.length
  }

  /**
   * 加载 symbol 索引。
   *
   * 优先从磁盘缓存加载（<24h），否则从 OpenBB API 拉取全量列表。
   * API 失败时降级到过期缓存。全部失败则以空索引启动（不中断）。
   */
  async load(client: EquityClientLike): Promise<void> {
    // 1. 尝试读缓存
    const cached = await this.readCache()
    if (cached && !this.isExpired(cached.cachedAt)) {
      this.entries = cached.entries
      console.log(`equity: loaded ${this.entries.length} symbols from cache (${cached.sources.join(', ')})`)
      return
    }

    // 2. 从 API 拉取
    try {
      const entries = await this.fetchFromApi(client)
      this.entries = entries
      await this.writeCache(entries)
      console.log(`equity: fetched ${entries.length} symbols from discovery endpoints`)
      return
    } catch (err) {
      console.warn('equity: API fetch failed:', err)
    }

    // 3. 降级到过期缓存
    if (cached) {
      this.entries = cached.entries
      console.warn(`equity: using expired cache (${cached.cachedAt}), ${this.entries.length} symbols`)
      return
    }

    // 4. 无缓存可用
    console.warn('equity: no symbol data available, starting with empty index')
  }

  /**
   * 用正则表达式搜索 symbol 和公司名称。
   *
   * - pattern 作为 RegExp（case-insensitive）同时匹配 symbol 和 name
   * - 正则编译失败时降级为子串匹配
   */
  search(pattern: string, limit = 20): SymbolEntry[] {
    let test: (s: string) => boolean

    try {
      const re = new RegExp(pattern, 'i')
      test = (s) => re.test(s)
    } catch {
      // 正则语法错误 → 降级为 case-insensitive 子串匹配
      const lower = pattern.toLowerCase()
      test = (s) => s.toLowerCase().includes(lower)
    }

    const results: SymbolEntry[] = []
    for (const entry of this.entries) {
      if (test(entry.symbol) || test(entry.name)) {
        results.push(entry)
        if (results.length >= limit) break
      }
    }
    return results
  }

  /** 精确匹配 symbol（case-insensitive） */
  resolve(symbol: string): SymbolEntry | undefined {
    const upper = symbol.toUpperCase()
    return this.entries.find((e) => e.symbol.toUpperCase() === upper)
  }

  // ==================== Internal ====================

  private async fetchFromApi(client: EquityClientLike): Promise<SymbolEntry[]> {
    const allEntries: SymbolEntry[] = []
    const seen = new Set<string>()

    for (const plan of SOURCE_PLANS) {
      if (!SUPPORTED_PROVIDERS.has(plan.provider)) {
        console.log(`equity: skipping unsupported provider ${plan.provider}`)
        continue
      }

      try {
        const method = client[plan.method] as ((params: Record<string, unknown>) => Promise<Record<string, unknown>[]>) | undefined
        if (!method) continue

        const results = await method.call(client, { provider: plan.provider, limit: plan.limit })
        const normalized = results
          .map((entry) => this.normalizeEntry(entry, `${plan.provider}/${plan.method}`))
          .filter((entry): entry is SymbolEntry => entry !== null)

        for (const entry of normalized) {
          const key = entry.symbol.toUpperCase()
          if (seen.has(key)) continue
          seen.add(key)
          allEntries.push(entry)
        }

        console.log(`equity: ${plan.provider}/${plan.method} -> ${normalized.length} symbols`)
      } catch (err) {
        console.warn(`equity: failed to fetch from ${plan.provider}/${plan.method}:`, err)
      }
    }

    if (allEntries.length === 0) {
      throw new Error('All sources returned empty')
    }

    return allEntries
  }

  private async readCache(): Promise<CacheEnvelope | null> {
    try {
      const raw = await readFile(CACHE_FILE, 'utf-8')
      return JSON.parse(raw) as CacheEnvelope
    } catch {
      return null
    }
  }

  private async writeCache(entries: SymbolEntry[]): Promise<void> {
    try {
      await mkdir(dirname(CACHE_FILE), { recursive: true })
      const envelope: CacheEnvelope = {
        cachedAt: new Date().toISOString(),
        sources: SOURCE_PLANS.map((plan) => `${plan.provider}/${plan.method}`),
        count: entries.length,
        entries,
      }
      await writeFile(CACHE_FILE, JSON.stringify(envelope))
    } catch {
      // 缓存写入失败不中断
    }
  }

  private isExpired(cachedAt: string): boolean {
    return Date.now() - new Date(cachedAt).getTime() > CACHE_TTL_MS
  }

  private normalizeEntry(entry: Record<string, unknown>, source: string): SymbolEntry | null {
    const rawSymbol = typeof entry.symbol === 'string' ? entry.symbol.trim() : ''
    if (!rawSymbol) return null

    const nameCandidate = [
      entry.name,
      entry.long_name,
      entry.short_name,
      entry.description,
      entry.title,
      entry.symbol,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)

    return {
      ...entry,
      symbol: rawSymbol,
      name: nameCandidate?.trim() ?? rawSymbol,
      source,
    }
  }
}
