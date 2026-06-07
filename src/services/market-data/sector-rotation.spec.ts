import { describe, expect, it, vi } from 'vitest'
import { calculateSectorRotation } from './sector-rotation.js'

describe('calculateSectorRotation', () => {
  it('sorts sector returns and preserves per-symbol failures', async () => {
    const fetcher = {
      historical: vi.fn(async ({ symbol }: { symbol: string }) => {
        if (symbol === 'BROKEN') return { rows: [], error: 'provider failed' }
        const last = symbol === 'XLK' ? 120 : 105
        return {
          rows: [
            { date: '2024-01-02', close: last },
            { date: '2024-01-01', close: 100 },
            { date: '2024-01-03', close: null },
          ],
        }
      }),
    }

    const result = await calculateSectorRotation(fetcher, {
      symbols: ['XLF', 'BROKEN', 'XLK'],
      benchmark: 'SPY',
      start_date: '2024-01-01',
    })

    expect(result).toMatchObject({
      assetClass: 'etf',
      interval: '1d',
      failures: [{ symbol: 'BROKEN', error: 'provider failed' }],
    })
    expect(result.sectors.map((sector) => sector.symbol)).toEqual(['XLK', 'XLF'])
    expect(result.sectors.map((sector) => sector.returnPct)).toEqual([20, 5])
    expect(result.benchmark?.symbol).toBe('SPY')
  })
})
