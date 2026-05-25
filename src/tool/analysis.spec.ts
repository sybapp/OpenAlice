import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAnalysisTools } from './analysis.js'
import { dataPath } from '@/core/paths'

function mockClient() {
  return {
    getHistorical: vi.fn(async () => []),
    getSpotPrices: vi.fn(async () => []),
  } as any
}

const toolOptions = { toolCallId: 'test', messages: [] as any, abortSignal: undefined as any }
const technicalAnalysisArtifactDir = dataPath('cache', 'technical-analysis')
let memoryDir = ''

async function cleanupTechnicalAnalysisArtifacts() {
  await rm(technicalAnalysisArtifactDir, { recursive: true, force: true })
}

describe('analysis tools', () => {
  beforeEach(async () => {
    await cleanupTechnicalAnalysisArtifacts()
    memoryDir = await mkdtemp(join(tmpdir(), 'openalice-analysis-memory-'))
  })

  afterEach(async () => {
    await cleanupTechnicalAnalysisArtifacts()
    if (memoryDir) await rm(memoryDir, { recursive: true, force: true })
  })

  it('exposes technical analysis tools and removes old public tool names', () => {
    const tools = createAnalysisTools(mockClient(), mockClient(), mockClient(), mockClient()) as Record<string, unknown>

    expect(tools.analyzeTechnicalAnalysis).toBeDefined()
    expect(tools.refineTechnicalAnalysis).toBeDefined()
    expect(tools.readTechnicalAnalysisSection).toBeDefined()
    expect(tools.listSymbolMemories).toBeDefined()
    expect(tools.readSymbolMemory).toBeDefined()
    expect(tools.recordSymbolReview).toBeDefined()
    expect(tools.analyzeSymbolPriceAction).toBeUndefined()
    expect(tools.analyzePriceAction).toBeUndefined()
  })

  it('getOHLCV returns normalized latest candles and filters invalid rows', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue([
      { date: '2026-05-07T14:30:00.000Z', open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { date: '2026-05-07T14:35:00.000Z', open: null, high: 12, low: 10, close: 11, volume: 110 },
      { date: '2026-05-07T14:40:00.000Z', open: '11', high: '13', low: '10', close: '12', volume: '120', vwap: '11.5' },
      { date: '2026-05-07T14:45:00.000Z', open: 12, high: 14, low: 11, close: 13, volume: 130 },
    ])
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())

    const result = await tools.getOHLCV.execute!(
      { asset: 'equity', symbol: 'QQQ', interval: '5m', limit: 2, includeIncomplete: true },
      toolOptions,
    ) as any

    expect(equity.getHistorical).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'QQQ',
      interval: '5m',
    }))
    expect(result.count).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.bars.map((bar: any) => bar.date)).toEqual([
      '2026-05-07T14:40:00.000Z',
      '2026-05-07T14:45:00.000Z',
    ])
    expect(result.bars[0]).toMatchObject({
      time: '2026-05-07T14:40:00.000Z',
      open: 11,
      high: 13,
      low: 10,
      close: 12,
      volume: 120,
      vwap: 11.5,
    })
  })

  it('getOHLCV excludes the current incomplete candle by default', async () => {
    const equity = mockClient()
    const currentBucket = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString()
    equity.getHistorical.mockResolvedValue([
      { date: '2026-05-07T14:30:00.000Z', open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { date: currentBucket, open: 11, high: 12, low: 10, close: 11, volume: 100 },
    ])
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())

    const result = await tools.getOHLCV.execute!(
      { asset: 'equity', symbol: 'QQQ', interval: '1m', limit: 10, includeIncomplete: false },
      toolOptions,
    ) as any

    expect(result.bars.map((bar: any) => bar.date)).toEqual(['2026-05-07T14:30:00.000Z'])
  })

  it('getOHLCV excludes today daily bars when providers return YYYY-MM-DD dates', async () => {
    const equity = mockClient()
    const today = new Date().toISOString().slice(0, 10)
    equity.getHistorical.mockResolvedValue([
      { date: '2026-05-07', open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { date: today, open: 11, high: 12, low: 10, close: 11, volume: 100 },
    ])
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())

    const result = await tools.getOHLCV.execute!(
      { asset: 'equity', symbol: 'QQQ', interval: '1d', limit: 10, includeIncomplete: false },
      toolOptions,
    ) as any

    expect(result.bars.map((bar: any) => bar.date)).toEqual(['2026-05-07'])
  })

  it('getOHLCV warns and uses daily interval for commodities', async () => {
    const commodity = mockClient()
    commodity.getSpotPrices.mockResolvedValue([
      { date: '2026-05-07', open: 3300, high: 3310, low: 3290, close: 3305, volume: null },
    ])
    const tools = createAnalysisTools(mockClient(), mockClient(), mockClient(), commodity)

    const result = await tools.getOHLCV.execute!(
      { asset: 'commodity', symbol: 'gold', interval: '5m', limit: 10, includeIncomplete: false },
      toolOptions,
    ) as any

    expect(commodity.getSpotPrices).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'gold',
      interval: '1d',
    }))
    expect(result.interval).toBe('1d')
    expect(result.warnings).toContain('Commodity spot prices only support daily bars; interval was treated as 1d.')
  })

  it('getOHLCV returns a structured no-data error', async () => {
    const tools = createAnalysisTools(mockClient(), mockClient(), mockClient(), mockClient())

    const result = await tools.getOHLCV.execute!(
      { asset: 'equity', symbol: 'NOPE', interval: '1d', limit: 10, includeIncomplete: false },
      toolOptions,
    ) as any

    expect(result.count).toBe(0)
    expect(result.error).toMatchObject({ code: 'NO_OHLCV_DATA' })
  })

  it('analyzeTechnicalAnalysis fetches candles, writes artifact, and returns a compact summary', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(24))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())

    const result = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '5m',
        limit: 50,
        includeIncomplete: true,
        options: { internalLookback: 2, swingLookback: 3, volumeLookback: 4 },
      },
      toolOptions,
    ) as any

    expect(result.analysisId).toMatch(/^ta_\d{8}T\d{6}_[0-9a-f]{8}$/)
    expect(result.kind).toBe('baseline')
    expect(result.data).toMatchObject({ symbol: 'QQQ', interval: '5m', bars: 24 })
    expect(result.data.recentCandles).toHaveLength(10)
    expect(result.summary).toMatchObject({ latestClose: expect.any(Number), warnings: expect.any(Array) })
    expect(result.requestedOptions).toMatchObject({ internalLookback: 2, swingLookback: 3, volumeLookback: 4 })
    expect(result.effectiveOptions).toMatchObject({
      structure: expect.objectContaining({ internalLookback: 2, swingLookback: 3 }),
      volume: expect.objectContaining({ volumeLookback: 4 }),
      confluence: expect.objectContaining({ vwapAnchor: 'auto' }),
    })
    expect(Object.keys(result.sections)).toEqual(['structure', 'zones', 'volume', 'confluence', 'candles', 'raw'])
    expect(result.optionPlaybook).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lens: 'anchored_vwap',
        tool: 'refineTechnicalAnalysis',
        input: expect.objectContaining({ analysisId: result.analysisId }),
      }),
    ]))
    expect(result.nextActions.map((action: any) => action.tool)).toContain('refineTechnicalAnalysis')
    expect(result.nextActions.map((action: any) => action.tool)).not.toContain('readTechnicalAnalysisSection')
    expect(result.topSignals.length).toBeLessThanOrEqual(8)
    expect(result.analysis).toBeUndefined()

    const index = JSON.parse(await readFile(join(technicalAnalysisArtifactDir, 'index.json'), 'utf-8'))
    expect(index.entries[result.analysisId]).toMatchObject({
      analysisId: result.analysisId,
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
    })
    expect(index.entries[result.analysisId].relativePath).toMatch(new RegExp(`^equity/QQQ/5m/\\d{4}-\\d{2}-\\d{2}/${result.analysisId}\\.json$`))
    const artifact = JSON.parse(await readFile(join(technicalAnalysisArtifactDir, index.entries[result.analysisId].relativePath), 'utf-8'))
    expect(artifact).toMatchObject({
      analysisId: result.analysisId,
      kind: 'baseline',
      artifactPath: index.entries[result.analysisId].relativePath,
      asset: 'equity',
      symbol: 'QQQ',
      interval: '5m',
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    expect(artifact.requestedOptions).toMatchObject({ internalLookback: 2, swingLookback: 3, volumeLookback: 4 })
    expect(artifact.effectiveOptions).toMatchObject({
      internalLookback: 2,
      swingLookback: 3,
      volumeLookback: 4,
      vwapAnchor: 'auto',
    })
  })

  it('analyzeTechnicalAnalysis updates compact symbol memory without raw candles', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(32))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient(), { symbolMemoryDir: memoryDir })

    const result = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '5m',
        limit: 50,
        includeIncomplete: true,
        options: { internalLookback: 2, swingLookback: 3, volumeLookback: 4 },
      },
      toolOptions,
    ) as any

    expect(result.symbolMemory).toMatchObject({
      updated: true,
      id: 'symbol_memory_equity_QQQ',
      path: join('symbols', 'equity', 'QQQ.md'),
    })

    const content = await readFile(join(memoryDir, 'symbols', 'equity', 'QQQ.md'), 'utf-8')
    expect(content).toContain('id: "symbol_memory_equity_QQQ"')
    expect(content).toContain('# Technical Analysis Memory - equity/QQQ')
    expect(content).toContain(`- latestAnalysisId: ${result.analysisId}`)
    expect(content).toContain('- provider: default')
    expect(content).toContain('## Interval 5m')
    expect(content).toContain('## Review Journal')
    expect(content).not.toContain('recentCandles')
    expect(content).not.toContain('"bars"')
    expect(content).not.toContain('"open"')
    expect(content).not.toContain('"high"')
    expect(content).not.toContain('"low"')
    expect(content).not.toContain('"close"')
  })

  it('analyzeTechnicalAnalysis injects only the current symbol memory lazily', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(40))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient(), { symbolMemoryDir: memoryDir })

    const qqq = await tools.analyzeTechnicalAnalysis.execute!(
      { asset: 'equity', symbol: 'QQQ', interval: '5m', limit: 40, includeIncomplete: true },
      toolOptions,
    ) as any
    expect(qqq.symbolMemory.prior).toMatchObject({
      found: false,
      id: 'symbol_memory_equity_QQQ',
      path: join('symbols', 'equity', 'QQQ.md'),
    })

    const qqqAgain = await tools.analyzeTechnicalAnalysis.execute!(
      { asset: 'equity', symbol: 'QQQ', interval: '5m', limit: 40, includeIncomplete: true },
      toolOptions,
    ) as any
    expect(qqqAgain.symbolMemory.prior).toMatchObject({ found: true, id: 'symbol_memory_equity_QQQ' })
    expect(qqqAgain.symbolMemory.prior.content).toContain(qqq.analysisId)

    const aapl = await tools.analyzeTechnicalAnalysis.execute!(
      { asset: 'equity', symbol: 'AAPL', interval: '5m', limit: 40, includeIncomplete: true },
      toolOptions,
    ) as any
    expect(aapl.symbolMemory.prior).toMatchObject({
      found: false,
      id: 'symbol_memory_equity_AAPL',
      path: join('symbols', 'equity', 'AAPL.md'),
    })
    expect(aapl.symbolMemory.prior.content).toBeUndefined()
  })

  it('analyzeTechnicalAnalysis exposes fine-grained requested and effective option tuning', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(80))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())

    const result = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '1d',
        limit: 80,
        includeIncomplete: false,
        options: {
          emaFastPeriod: 20,
          emaSlowPeriod: 50,
          emaLongPeriod: 200,
          vwapAnchor: 'structure',
          fib: { levels: [0.236, 0.382, 0.618] },
          volumeProfile: { mode: 'rolling', lookback: 60, bins: 40, valueAreaPercent: 68 },
          zoneFilter: { maxDistanceAtr: 6, includeFilledFairValueGaps: true },
        },
      },
      toolOptions,
    ) as any

    expect(result.requestedOptions).toMatchObject({
      emaFastPeriod: 20,
      emaSlowPeriod: 50,
      emaLongPeriod: 200,
      vwapAnchor: 'structure',
      fib: { levels: [0.236, 0.382, 0.618] },
      volumeProfile: { mode: 'rolling', lookback: 60, bins: 40, valueAreaPercent: 68 },
      zoneFilter: { maxDistanceAtr: 6, includeFilledFairValueGaps: true },
    })
    expect(result.effectiveOptions).toMatchObject({
      confluence: expect.objectContaining({
        emaPeriods: [20, 50, 200],
        vwapAnchor: 'structure',
        fib: expect.objectContaining({ levels: [0.236, 0.382, 0.618] }),
      }),
      volume: expect.objectContaining({
        volumeProfile: expect.objectContaining({ mode: 'rolling', lookback: 60, bins: 40, valueAreaPercent: 68 }),
      }),
      zones: expect.objectContaining({
        zoneFilter: expect.objectContaining({ maxDistanceAtr: 6, includeFilledFairValueGaps: true }),
      }),
    })
  })

  it('refineTechnicalAnalysis reruns stored bars with new options without fetching provider data', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(120))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())
    const baseline = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '1d',
        limit: 120,
        includeIncomplete: false,
      },
      toolOptions,
    ) as any
    expect(equity.getHistorical).toHaveBeenCalledTimes(1)

    const refined = await tools.refineTechnicalAnalysis.execute!(
      {
        analysisId: baseline.analysisId,
        reason: 'monthly VWAP and 20/50/200 EMA confluence',
        options: {
          emaFastPeriod: 20,
          emaSlowPeriod: 50,
          emaLongPeriod: 200,
          vwapAnchor: 'month',
        },
      },
      toolOptions,
    ) as any

    expect(equity.getHistorical).toHaveBeenCalledTimes(1)
    expect(refined.analysisId).toMatch(/^ta_\d{8}T\d{6}_[0-9a-f]{8}$/)
    expect(refined.analysisId).not.toBe(baseline.analysisId)
    expect(refined.kind).toBe('refined')
    expect(refined.parentAnalysisId).toBe(baseline.analysisId)
    expect(refined.refinementReason).toBe('monthly VWAP and 20/50/200 EMA confluence')
    expect(refined.requestedOptions).toMatchObject({
      emaFastPeriod: 20,
      emaSlowPeriod: 50,
      emaLongPeriod: 200,
      vwapAnchor: 'month',
    })
    expect(refined.effectiveOptions).toMatchObject({
      confluence: expect.objectContaining({ emaPeriods: [20, 50, 200], vwapAnchor: 'month' }),
    })
    expect(refined.nextActions.map((action: any) => action.tool)).toContain('readTechnicalAnalysisSection')

    const confluence = await tools.readTechnicalAnalysisSection.execute!(
      { analysisId: refined.analysisId, section: 'confluence', limit: 20 },
      toolOptions,
    ) as any
    expect(confluence).toMatchObject({ analysisId: refined.analysisId, section: 'confluence', limit: 20 })

    const index = JSON.parse(await readFile(join(technicalAnalysisArtifactDir, 'index.json'), 'utf-8'))
    expect(index.entries[refined.analysisId]).toMatchObject({
      analysisId: refined.analysisId,
      kind: 'refined',
      parentAnalysisId: baseline.analysisId,
      asset: 'equity',
      symbol: 'QQQ',
      interval: '1d',
    })
    const artifact = JSON.parse(await readFile(join(technicalAnalysisArtifactDir, index.entries[refined.analysisId].relativePath), 'utf-8'))
    expect(artifact).toMatchObject({
      kind: 'refined',
      parentAnalysisId: baseline.analysisId,
      refinementReason: 'monthly VWAP and 20/50/200 EMA confluence',
    })
  })

  it('refineTechnicalAnalysis updates the same symbol memory and preserves the review journal', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(120))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient(), { symbolMemoryDir: memoryDir })
    const baseline = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '1d',
        limit: 120,
        includeIncomplete: false,
      },
      toolOptions,
    ) as any
    await tools.recordSymbolReview.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        outcome: 'pending',
        analysisId: baseline.analysisId,
        notes: 'Watch whether the support zone holds.',
      },
      toolOptions,
    )

    const refined = await tools.refineTechnicalAnalysis.execute!(
      {
        analysisId: baseline.analysisId,
        reason: 'monthly VWAP and 20/50/200 EMA confluence',
        options: { emaFastPeriod: 20, emaSlowPeriod: 50, emaLongPeriod: 200, vwapAnchor: 'month' },
      },
      toolOptions,
    ) as any

    expect(refined.symbolMemory).toMatchObject({ updated: true, id: 'symbol_memory_equity_QQQ' })
    const content = await readFile(join(memoryDir, 'symbols', 'equity', 'QQQ.md'), 'utf-8')
    expect(content).toContain(`- latestAnalysisId: ${refined.analysisId}`)
    expect(content).toContain(`- parentAnalysisId: ${baseline.analysisId}`)
    expect(content).toContain('Watch whether the support zone holds.')
  })

  it('preserves symbol review journal when analysis and review writes overlap', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(120))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient(), { symbolMemoryDir: memoryDir })
    const baseline = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '1d',
        limit: 120,
        includeIncomplete: false,
      },
      toolOptions,
    ) as any

    const [recorded, refined] = await Promise.all([
      tools.recordSymbolReview.execute!(
        {
          asset: 'equity',
          symbol: 'QQQ',
          outcome: 'pending',
          analysisId: baseline.analysisId,
          notes: 'Concurrent review note should survive.',
        },
        toolOptions,
      ) as any,
      tools.refineTechnicalAnalysis.execute!(
        {
          analysisId: baseline.analysisId,
          reason: 'same symbol concurrent refresh',
          options: { emaFastPeriod: 20 },
        },
        toolOptions,
      ) as any,
    ])

    expect(recorded).toMatchObject({ recorded: true })
    expect(refined.symbolMemory).toMatchObject({ updated: true })
    const content = await readFile(join(memoryDir, 'symbols', 'equity', 'QQQ.md'), 'utf-8')
    expect(content).toContain(`- latestAnalysisId: ${refined.analysisId}`)
    expect(content).toContain('Concurrent review note should survive.')
  })

  it('list/read/record symbol memory tools handle the review workflow', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(40))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient(), { symbolMemoryDir: memoryDir })
    const summary = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '5m',
        limit: 40,
        includeIncomplete: true,
      },
      toolOptions,
    ) as any

    const listed = await tools.listSymbolMemories.execute!({}, toolOptions) as any
    expect(listed).toMatchObject({
      count: 1,
      memories: [
        {
          id: 'symbol_memory_equity_QQQ',
          path: join('symbols', 'equity', 'QQQ.md'),
          asset: 'equity',
          symbol: 'QQQ',
        },
      ],
    })

    const recorded = await tools.recordSymbolReview.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        outcome: 'valid',
        analysisId: summary.analysisId,
        notes: 'Breakout continuation confirmed near resistance.',
      },
      toolOptions,
    ) as any
    expect(recorded).toMatchObject({ recorded: true, outcome: 'valid', analysisId: summary.analysisId })

    const read = await tools.readSymbolMemory.execute!(
      { asset: 'equity', symbol: 'QQQ' },
      toolOptions,
    ) as any
    expect(read).toMatchObject({
      id: 'symbol_memory_equity_QQQ',
      asset: 'equity',
      symbol: 'QQQ',
    })
    expect(read.content).toContain('Breakout continuation confirmed near resistance.')
    expect(read.content).toContain(summary.analysisId)
  })

  it('analyzeTechnicalAnalysis returns no-data errors without writing an artifact', async () => {
    const tools = createAnalysisTools(mockClient(), mockClient(), mockClient(), mockClient())

    const result = await tools.analyzeTechnicalAnalysis.execute!(
      { asset: 'equity', symbol: 'NOPE', interval: '1d', limit: 50, includeIncomplete: false },
      toolOptions,
    ) as any

    expect(result.error).toMatchObject({ code: 'NO_OHLCV_DATA' })
    expect(result.analysis).toBeUndefined()
    await expect(readdir(technicalAnalysisArtifactDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('readTechnicalAnalysisSection reads focused sections and honors section limit caps', async () => {
    const equity = mockClient()
    equity.getHistorical.mockResolvedValue(buildTechnicalAnalysisBars(260))
    const tools = createAnalysisTools(equity, mockClient(), mockClient(), mockClient())
    const summary = await tools.analyzeTechnicalAnalysis.execute!(
      {
        asset: 'equity',
        symbol: 'QQQ',
        interval: '5m',
        limit: 260,
        includeIncomplete: true,
        options: {
          internalLookback: 2,
          swingLookback: 3,
          volumeLookback: 20,
          fib: { enabled: true, anchorMode: 'structure-leg' },
          confluenceZone: { enabled: true, maxVisible: 20 },
          volumeProfile: { enabled: true, lookback: 20, bins: 20 },
          unusualVolume: { enabled: true, baselineLookback: 20 },
          stopZone: { enabled: true, maxActive: 20 },
          vwapDeviation: { enabled: true, bandLookback: 20, signalEnabled: true },
        },
      },
      toolOptions,
    ) as any

    const sections = await Promise.all(['structure', 'zones', 'volume', 'confluence', 'candles', 'raw'].map((section) =>
      tools.readTechnicalAnalysisSection.execute!(
        { analysisId: summary.analysisId, section: section as any, limit: 500 },
        toolOptions,
      ) as Promise<any>,
    ))

    expect(sections[0]).toMatchObject({ section: 'structure', limit: 200 })
    expect(sections[0].structureEvents.length).toBeLessThanOrEqual(200)
    expect(sections[1]).toMatchObject({ section: 'zones' })
    expect(sections[1].zones.length).toBeLessThanOrEqual(200)
    expect(sections[2]).toMatchObject({ section: 'volume' })
    expect(sections[2].volumePriceSignals.length).toBeLessThanOrEqual(200)
    expect(sections[3]).toMatchObject({ section: 'confluence' })
    expect(sections[4]).toMatchObject({ section: 'candles', limit: 100 })
    expect(sections[4].candles).toHaveLength(100)
    expect(sections[5]).toMatchObject({ section: 'raw', limit: 200 })
    expect(sections[5].pivots.length).toBeLessThanOrEqual(200)
  })
})

function buildTechnicalAnalysisBars(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + Math.sin(index / 3) * 8 + index * 0.15
    const close = base + Math.cos(index / 2) * 3
    return {
      date: new Date(Date.UTC(2026, 4, 7, 14, 30 + index * 5)).toISOString(),
      open: base,
      high: Math.max(base, close) + 1.5 + (index % 5) * 0.1,
      low: Math.min(base, close) - 1.5 - (index % 4) * 0.1,
      close,
      volume: 1000 + (index % 9) * 120 + (index === count - 3 ? 3000 : 0),
      vwap: base - 0.2,
    }
  })
}
