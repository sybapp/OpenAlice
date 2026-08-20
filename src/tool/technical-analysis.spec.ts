import { describe, expect, it, vi } from 'vitest'
import type { BarService, BarsResult, OhlcvBar } from '@/domain/market-data/bars/index.js'
import { createTechnicalAnalysisTools } from './technical-analysis.js'

function run<T>(tool: { execute?: unknown }, args: unknown): Promise<T> {
  return (tool.execute as (input: unknown, options: unknown) => Promise<T>)(args, {})
}

function targetBars(): OhlcvBar[] {
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + index * 0.4 + (index % 4 === 0 ? 0.8 : 0)
    return {
      date: `2024-01-01 09:${String(index).padStart(2, '0')}:00`,
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 1000 + index * 10,
    }
  })
}

describe('createTechnicalAnalysisTools', () => {
  it('exposes one unified technical-analysis entrypoint', () => {
    const tools = createTechnicalAnalysisTools({
      barService: { searchBarSources: vi.fn(), getBars: vi.fn() } as unknown as BarService,
    })

    expect(Object.keys(tools)).toEqual(['analyzeTechnicalAnalysis'])
    const schema = (tools.analyzeTechnicalAnalysis as any).inputSchema
    for (const interval of ['1m', '5m', '15m']) {
      expect(schema.safeParse({ barId: 'tradingview|AAPL', interval }).success).toBe(true)
    }
    expect(schema.safeParse({ barId: 'alpaca-paper|AAPL', interval: '2h' }).success).toBe(false)
    expect(schema.safeParse({ barId: 'tradingview|AAPL' }).success).toBe(false)
    expect(tools.analyzeTechnicalAnalysis.description).toContain('EMA/VWAP/Fibonacci')
    expect(tools.analyzeTechnicalAnalysis.description).toContain('bar_proxy')
  })

  it('loads the target window once and returns all analysis families together', async () => {
    const target = targetBars()
    const barService: BarService = {
      searchBarSources: vi.fn(),
      getBars: vi.fn()
        .mockResolvedValueOnce({
          bars: target,
          meta: {
            symbol: 'AAPL',
            from: '2024-01-01',
            to: '2024-01-01',
            bars: target.length,
            barId: 'tradingview|AAPL',
            supportedIntervals: ['1m', '15m'],
          },
        } as BarsResult)
        .mockResolvedValueOnce({
          bars: [],
          meta: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-01', bars: 0 },
        } as BarsResult),
    }
    const tools = createTechnicalAnalysisTools({ barService })

    const result = await run<any>(tools.analyzeTechnicalAnalysis, {
      barId: 'tradingview|AAPL',
      interval: '15m',
      count: target.length,
    })

    expect(result.status).toBe('ok')
    expect(result.intervals).toHaveLength(1)
    expect(result.intervals[0]).toMatchObject({
      status: 'ok',
      summary: {
        emaBias: 'bullish',
        orderFlowStatus: 'no_intrabars',
      },
      indicators: {
        ema: { bias: 'bullish' },
      },
      priceAction: {
        marketStructure: expect.any(Object),
      },
      orderFlow: {
        status: 'no_intrabars',
      },
    })
    expect(result.intervals[0].indicators.vwap).toMatchObject({ relation: 'above' })
    expect((barService.getBars as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
    expect(barService.getBars).toHaveBeenNthCalledWith(1, { barId: 'tradingview|AAPL' }, {
      interval: '15m',
      count: 200,
      start: undefined,
      end: undefined,
    })
    expect(result.intervals[0].priceAction.meta).toMatchObject({
      volumeConfirmation: 'unavailable',
      volumeConfirmationIntrabarCount: 0,
    })
  })
})
