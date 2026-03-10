import { describe, it, expect } from 'vitest'
import type { OhlcvData } from '../indicator/types'
import { fetchOhlcvByBars } from './fetch'

describe('fetchOhlcvByBars', () => {
  it('slices to exact lookbackBars when enough data', async () => {
    const lookbackBars = 300

    const start = new Date('2026-01-01T00:00:00.000Z').getTime()
    const stepMs = 5 * 60 * 1000

    const raw: OhlcvData[] = Array.from({ length: 400 }, (_, i) => ({
      date: new Date(start + i * stepMs).toISOString(),
      open: i,
      high: i,
      low: i,
      close: i,
      volume: 1,
    }))

    // scramble order to ensure sort is applied
    const shuffled = [...raw].reverse()

    const client = {
      getHistorical: async (_params: Record<string, unknown>) => shuffled as unknown[],
    }

    const data = await fetchOhlcvByBars({
      client,
      symbol: 'TEST',
      interval: '5m',
      lookbackBars,
      paddingBars: 10,
    })

    expect(data).toHaveLength(lookbackBars)
    // should be sorted ascending
    expect(data[0].date < data[data.length - 1].date).toBe(true)
    // should be last 300 of original ascending sequence
    expect(data[0].close).toBe(100)
    expect(data[data.length - 1].close).toBe(399)
  })
})
