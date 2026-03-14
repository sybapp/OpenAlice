import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EquityClientLike } from '../sdk/types.js'

function makeClient(): EquityClientLike {
  return {
    search: vi.fn(),
    getHistorical: vi.fn(),
    getProfile: vi.fn(),
    getKeyMetrics: vi.fn(),
    getIncomeStatement: vi.fn(),
    getBalanceSheet: vi.fn(),
    getCashFlow: vi.fn(),
    getFinancialRatios: vi.fn(),
    getEstimateConsensus: vi.fn(),
    getCalendarEarnings: vi.fn(),
    getInsiderTrading: vi.fn(),
    getGainers: vi.fn(async ({ provider }: Record<string, unknown>) => {
      if (provider === 'fmp') throw new Error('no key')
      return [
        { symbol: 'NVDA', name: 'NVIDIA Corporation' },
        { symbol: 'AAPL', short_name: 'Apple' },
      ]
    }),
    getLosers: vi.fn(async () => [
      { symbol: 'TSLA', long_name: 'Tesla, Inc.' },
      { symbol: 'AAPL', name: 'Apple Inc.' },
    ]),
    getActive: vi.fn(async () => [
      { symbol: 'MSFT', name: 'Microsoft Corporation' },
      { symbol: 'NVDA', name: 'NVIDIA Corporation' },
    ]),
  }
}

describe('SymbolIndex', () => {
  let repoRoot: string
  let tempRoot: string

  beforeEach(async () => {
    repoRoot = process.cwd()
    tempRoot = await mkdtemp(join(tmpdir(), 'openalice-symbol-index-'))
    process.chdir(tempRoot)
    vi.resetModules()
  })

  afterEach(async () => {
    process.chdir(repoRoot)
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('builds an index from supported discovery endpoints and deduplicates symbols', async () => {
    const { SymbolIndex } = await import('./SymbolIndex.js')
    const index = new SymbolIndex()
    const client = makeClient()

    await index.load(client)

    expect(index.size).toBeGreaterThanOrEqual(4)
    expect(index.resolve('AAPL')).toMatchObject({ symbol: 'AAPL', name: 'Apple' })
    expect(index.resolve('NVDA')).toMatchObject({ symbol: 'NVDA' })
    expect(index.resolve('TSLA')).toMatchObject({ symbol: 'TSLA', name: 'Tesla, Inc.' })
    expect(client.getActive).toHaveBeenCalled()
    expect(client.getGainers).toHaveBeenCalled()
    expect(client.getLosers).toHaveBeenCalled()
  })
})
