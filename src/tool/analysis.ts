/**
 * Analysis Kit — 统一量化因子计算工具
 *
 * 通过 asset 参数区分资产类别（equity/crypto/currency），
 * 公式语法完全一样：CLOSE('AAPL', '1d')、SMA(...)、RSI(...) 等。
 * 数据按需从 market-data client 拉取 OHLCV；不引入 master 的 OHLCV cache/watch 配置。
 */

import { tool } from 'ai'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { EquityClientLike, CryptoClientLike, CurrencyClientLike, CommodityClientLike } from '@/domain/market-data/client/types'
import { IndicatorCalculator } from '@/domain/analysis/indicator/calculator'
import type { IndicatorContext, OhlcvData, HistoricalDataResult, DataSourceMeta } from '@/domain/analysis/indicator/types'
import { TechnicalAnalysisAnalyzer } from '@/domain/analysis/technical-analysis/analyzer'
import type { TechnicalAnalysisAnalysis } from '@/domain/analysis/technical-analysis/types'
import { normalizeOptions } from '@/domain/analysis/technical-analysis/options'
import { dataPath } from '@/core/paths'

const technicalAnalysisOptionsSchema = z.object({
  internalLookback: z.number().int().min(2).max(100).optional().describe('Internal pivot lookback for short-term structure. Default 5; lower values react faster and produce more MSS/BOS candidates.'),
  swingLookback: z.number().int().min(2).max(250).optional().describe('Swing pivot lookback for higher-timeframe structure. Default 50; raise it for major swings, lower it for active/intraday structure.'),
  useCloseBreak: z.boolean().optional().describe('Whether structure breaks require candle close beyond the pivot. Default true; false allows wick breaks and is more sensitive to sweeps.'),
  zoneMode: z.enum(['Fast', 'Slow']).optional().describe('Zone detection sensitivity. Default Fast; Slow is more conservative and produces fewer structural zones.'),
  fvgMode: z.enum(['FVG', 'VI', 'OG', 'IFVG']).optional().describe('Imbalance detector mode. Default FVG; IFVG emphasizes inverted fair-value gaps after a failed/filled imbalance.'),
  obFilter: z.enum(['None', 'MSS', 'BOS']).optional().describe('Order-block filter. Default None; MSS ties OBs to reversal structure, BOS ties them to continuation breaks.'),
  obMitigation: z.enum(['Absolute', 'Middle']).optional().describe('Order-block mitigation rule. Default Absolute; Middle treats a midpoint touch as mitigation.'),
  obPosition: z.enum(['Full', 'Middle', 'Accurate', 'Precise']).optional().describe('Order-block price range style. Default Precise; Full is wider, Middle/Accurate/Precise progressively narrow the zone.'),
  volumeLookback: z.number().int().min(2).max(250).optional().describe('Lookback used for breakout volume scores, VWAP rolling context, and volume confirmations. Default 20.'),
  emaFastPeriod: z.number().int().min(2).max(500).optional().describe('Fast EMA period for confluence. Default 12; use shorter values for intraday momentum.'),
  emaSlowPeriod: z.number().int().min(2).max(500).optional().describe('Slow EMA period for confluence. Default 20; use with fast/long EMA to classify trend bias.'),
  emaLongPeriod: z.number().int().min(2).max(500).optional().describe('Long EMA period for confluence. Default 50; use 100/200 for higher-timeframe trend filters.'),
  vwapEnabled: z.boolean().optional().describe('Enable VWAP context in confluence and volume-price signals. Default true; disable only when volume data is unreliable.'),
  vwapAnchor: z.enum(['auto', 'rolling', 'session', 'week', 'month', 'year', 'structure']).optional().describe('VWAP anchor. Default auto; rolling uses volumeLookback, session resets daily, week/month/year reset by calendar, structure anchors from the latest structure break.'),
  fib: z.object({
    enabled: z.boolean().optional().describe('Enable Fibonacci retracements. Default true.'),
    anchorMode: z.literal('structure-leg').optional().describe('Fib anchor mode. Only structure-leg is currently supported.'),
    levels: z.array(z.number().gt(0).lt(1)).min(1).optional().describe('Retracement ratios between 0 and 1. Default [0.382, 0.5, 0.618, 0.786].'),
  }).optional().describe('Fibonacci retracement options for structure-leg confluence.'),
  confluenceZone: z.object({
    enabled: z.boolean().optional().describe('Enable grouped confluence zones. Default true.'),
    minFamilies: z.number().int().min(2).max(3).optional().describe('Minimum indicator families required for a confluence zone. Default 2; use 3 for stricter zones.'),
    overlapAtrMultiplier: z.number().positive().optional().describe('ATR overlap tolerance for grouping nearby levels. Default 0.25.'),
    maxVisible: z.number().int().min(1).max(200).optional().describe('Maximum confluence zones retained before section limits. Default 8.'),
  }).optional().describe('Options for grouping FIB/VWAP/EMA/zone evidence into confluence zones.'),
  volumeProfile: z.object({
    enabled: z.boolean().optional().describe('Enable volume profile, POC, value area, and low-volume void detection. Default true.'),
    mode: z.enum(['rolling', 'session']).optional().describe('Volume profile window. Default rolling; session is useful for intraday/session context.'),
    lookback: z.number().int().min(20).max(2000).optional().describe('Bars used for rolling volume profile. Default 300; increase for higher-timeframe composite profiles.'),
    bins: z.number().int().min(20).max(400).optional().describe('Number of price bins. Default 150; higher values give finer POC/void resolution.'),
    valueAreaPercent: z.number().min(1).max(100).optional().describe('Value-area percentage around POC. Default 70.'),
    smoothing: z.number().int().min(0).max(20).optional().describe('Bin smoothing radius. Default 3; lower for sharper voids, higher for smoother profiles.'),
    voidThresholdRatio: z.number().positive().optional().describe('Low-volume void threshold as a ratio of peak/bin volume. Default 0.15.'),
  }).optional().describe('Volume profile options for POC, VAH/VAL, skew, and low-volume void evidence.'),
  unusualVolume: z.object({
    enabled: z.boolean().optional().describe('Enable unusual volume spike detection. Default true.'),
    baselineLookback: z.number().int().min(20).max(1000).optional().describe('Bars used to compute baseline volume. Default 200.'),
    zScoreThreshold: z.number().positive().optional().describe('Minimum volume z-score for unusual volume. Default 2.'),
    rvolThreshold: z.number().positive().optional().describe('Minimum relative volume multiple. Default 1.5.'),
  }).optional().describe('Unusual volume detector thresholds.'),
  stopZone: z.object({
    enabled: z.boolean().optional().describe('Enable stop-zone and stop-run detection around swing liquidity. Default true.'),
    pivotLookback: z.number().int().min(2).max(250).optional().describe('Pivot lookback used for stop zones. Default 50.'),
    maxActive: z.number().int().min(1).max(100).optional().describe('Maximum active stop zones retained. Default 10.'),
    volumeMultiplier: z.number().positive().optional().describe('Volume multiple required to mark a stop zone as triggered. Default 1.2.'),
  }).optional().describe('Stop-zone and stop-run detector options.'),
  vwapDeviation: z.object({
    enabled: z.boolean().optional().describe('Enable VWAP deviation bands. Default true.'),
    stdDevMultiplier: z.number().positive().optional().describe('Standard-deviation band multiplier around VWAP. Default 2.'),
    bandLookback: z.number().int().min(5).max(1000).optional().describe('Lookback used to estimate VWAP deviation bands. Default 50.'),
    signalEnabled: z.boolean().optional().describe('Emit volume-price signals when close is outside VWAP deviation bands. Default true.'),
  }).optional().describe('VWAP deviation band and signal options.'),
  atrPeriod: z.number().int().min(2).max(500).optional().describe('ATR period for distances, filters, and zone tolerances. Default 200.'),
  equalToleranceAtr: z.number().min(0).optional().describe('ATR multiple used to group equal highs/lows. Default 0.1.'),
  maxOrderBlocks: z.number().int().min(1).max(100).optional().describe('Legacy top-level cap for detected order blocks before relevance filtering. Default 10.'),
  liquidity: z.object({
    enabled: z.boolean().optional().describe('Enable liquidity pool and sweep detection. Default true.'),
    atrMargin: z.number().positive().optional().describe('ATR distance used to cluster similar highs/lows into liquidity zones. Default 2.5.'),
    minClusterSize: z.number().int().min(2).max(20).optional().describe('Minimum number of nearby pivots required for a liquidity zone. Default 3.'),
    maxVisible: z.number().int().min(1).max(200).optional().describe('Maximum liquidity zones retained before section limits. Default 12.'),
  }).optional().describe('Liquidity pool, equal high/low, and sweep detector options.'),
  bpr: z.object({
    enabled: z.boolean().optional().describe('Enable balance price range detection from overlapping opposing imbalances. Default true.'),
    maxVisible: z.number().int().min(1).max(100).optional().describe('Maximum BPR zones retained before section limits. Default 8.'),
  }).optional().describe('Balance price range detector options.'),
  limits: z.object({
    maxStructureEvents: z.number().int().min(20).max(5000).optional().describe('Maximum structure events kept in full analysis. Default 600.'),
    maxOrderBlocks: z.number().int().min(5).max(500).optional().describe('Maximum order blocks kept in full analysis. Default 120.'),
    maxFairValueGaps: z.number().int().min(5).max(1000).optional().describe('Maximum FVG/IFVG entries kept in full analysis. Default 240.'),
    maxLiquidityZones: z.number().int().min(5).max(500).optional().describe('Maximum liquidity zones kept in full analysis. Default 120.'),
    maxBalancePriceRanges: z.number().int().min(5).max(500).optional().describe('Maximum BPR entries kept in full analysis. Default 120.'),
    maxVolumeSignals: z.number().int().min(20).max(5000).optional().describe('Maximum volume-price signals kept in full analysis. Default 800.'),
  }).optional().describe('Internal retention caps for stored artifact arrays; readTechnicalAnalysisSection still applies section caps.'),
  zoneFilter: z.object({
    enabled: z.boolean().optional().describe('Enable relevance filtering for user-facing zones. Default true.'),
    includeMitigatedOrderBlocks: z.boolean().optional().describe('Include mitigated order blocks in relevance zones. Default false.'),
    includeInvalidatedOrderBlocks: z.boolean().optional().describe('Include invalidated order blocks in relevance zones. Default false.'),
    includeFilledFairValueGaps: z.boolean().optional().describe('Include filled fair-value gaps in relevance zones. Default false.'),
    maxAgeBars: z.number().int().min(1).max(10000).optional().describe('Maximum zone age in bars for relevance filtering. Default 160.'),
    maxDistanceAtr: z.number().positive().optional().describe('Maximum distance from latest close in ATR units. Default 4.'),
    minGapAtr: z.number().min(0).optional().describe('Minimum FVG/BPR size in ATR units for relevance. Default 0.1.'),
    minGapPercent: z.number().min(0).optional().describe('Minimum FVG/BPR size as price percent for relevance. Default 0.0003.'),
    maxZones: z.number().int().min(1).max(200).optional().describe('Maximum merged relevant zones returned in summary/relevance. Default 12.'),
    mergeOverlappingZones: z.boolean().optional().describe('Merge overlapping relevant zones. Default true.'),
  }).optional().describe('Relevance filter controlling which support/resistance zones are emphasized in summary and zones section.'),
}).describe('Fine-grained technical-analysis detector options. Use these when the user asks about specific anchors, lookbacks, FIB levels, VWAP behavior, volume profile, liquidity, or zone relevance.')

type TechnicalAnalysisToolOptions = z.infer<typeof technicalAnalysisOptionsSchema>
type TechnicalAnalysisRefineAction = {
  lens: string
  when: string
  tool: 'refineTechnicalAnalysis'
  input: {
    analysisId: string
    options: TechnicalAnalysisToolOptions
    reason: string
  }
}

const ohlcvAssetSchema = z.enum(['equity', 'crypto', 'currency', 'commodity'])
const technicalAnalysisSectionSchema = z.enum(['structure', 'zones', 'volume', 'confluence', 'candles', 'raw'])
const technicalAnalysisArtifactDir = dataPath('cache', 'technical-analysis')
const technicalAnalysisIndexPath = join(technicalAnalysisArtifactDir, 'index.json')
const symbolReviewOutcomeSchema = z.enum(['pending', 'valid', 'invalid', 'mixed', 'missed', 'neutral'])
const symbolMemoryAutoStart = '<!-- technical-analysis:symbol-memory:auto:start -->'
const symbolMemoryAutoEnd = '<!-- technical-analysis:symbol-memory:auto:end -->'
const symbolMemoryReviewHeading = '## Review Journal'

interface NormalizedCandle {
  time: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  vwap?: number | null
}

interface OhlcvFetchParams {
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
  interval: string
  limit: number
  startDate?: string
  endDate?: string
  provider?: string
  includeIncomplete?: boolean
}

interface OhlcvFetchResult {
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
  interval: string
  provider: string | null
  count: number
  from: string
  to: string
  truncated: boolean
  warnings: string[]
  bars: NormalizedCandle[]
  error?: {
    code: string
    message: string
  }
}

interface TechnicalAnalysisArtifact {
  analysisId: string
  kind: 'baseline' | 'refined'
  parentAnalysisId?: string
  refinementReason?: string
  createdAt: string
  artifactPath: string
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
  interval: string
  date: string
  data: ReturnType<typeof summarizeOhlcvResult>
  warnings: string[]
  bars: NormalizedCandle[]
  requestedOptions?: TechnicalAnalysisToolOptions
  effectiveOptions: ReturnType<typeof normalizeOptions>
  analysis: TechnicalAnalysisAnalysis
  summaryView: TechnicalAnalysisSummaryView
}

interface MemoryEntry {
  id: string
  path: string
  content: string
}

interface MemoryUpsertInput {
  path: string
  id: string
  type: 'trading'
  title: string
  description: string
  keywords: string[]
  updatedAt: string
  body: string
}

interface SymbolMemoryStoreLike {
  list(): Promise<MemoryEntry[]>
  get(id: string): Promise<MemoryEntry | null>
  upsert(input: MemoryUpsertInput): Promise<MemoryEntry>
}

interface AnalysisToolDeps {
  symbolMemoryDir?: string
}

const symbolMemoryQueues = new Map<string, Promise<unknown>>()

interface SymbolMemoryRef {
  id: string
  path: string
  relativePath: string
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
}

interface SymbolMemoryStatus {
  prior?: SymbolMemoryPrior
  updated: boolean
  id: string
  path: string
  error?: {
    code: string
    message: string
  }
}

interface SymbolMemoryPrior {
  found: boolean
  id: string
  path: string
  content?: string
  error?: {
    code: string
    message: string
  }
}

interface TechnicalAnalysisArtifactIndex {
  version: 1
  entries: Record<string, TechnicalAnalysisArtifactIndexEntry>
}

interface TechnicalAnalysisArtifactIndexEntry {
  analysisId: string
  kind: 'baseline' | 'refined'
  parentAnalysisId?: string
  relativePath: string
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
  interval: string
  provider: string | null
  createdAt: string
  from: string
  to: string
}

interface TechnicalAnalysisSummaryView {
  analysisId: string
  kind: 'baseline' | 'refined'
  parentAnalysisId?: string
  refinementReason?: string
  data: ReturnType<typeof buildTechnicalAnalysisDataView>
  summary: {
    trend: TechnicalAnalysisAnalysis['summary']['trend']
    internalTrend: TechnicalAnalysisAnalysis['summary']['internalTrend']
    swingTrend: TechnicalAnalysisAnalysis['summary']['swingTrend']
    latestClose?: number
    nearestSupport?: TechnicalAnalysisAnalysis['relevance']['nearestSupport']
    nearestResistance?: TechnicalAnalysisAnalysis['relevance']['nearestResistance']
    warnings: string[]
  }
  requestedOptions?: TechnicalAnalysisToolOptions
  effectiveOptions: ReturnType<typeof buildTechnicalAnalysisOptionsSummary>
  optionPlaybook: ReturnType<typeof buildTechnicalAnalysisOptionPlaybook>
  topSignals: Array<Record<string, unknown>>
  symbolMemory?: SymbolMemoryStatus
  sections: Record<z.infer<typeof technicalAnalysisSectionSchema>, {
    description: string
    defaultLimit: number
  }>
  nextActions: Array<{
    tool: 'refineTechnicalAnalysis' | 'readTechnicalAnalysisSection'
    input: ({
      analysisId: string
      options: TechnicalAnalysisToolOptions
      reason?: string
    } | {
      analysisId: string
      section: z.infer<typeof technicalAnalysisSectionSchema>
      limit?: number
    })
    when: string
  }>
}

class TechnicalAnalysisSymbolMemoryStore implements SymbolMemoryStoreLike {
  constructor(private readonly memoryDir = dataPath('brain', 'memory')) {}

  async list(): Promise<MemoryEntry[]> {
    const symbolsDir = this.resolveMemoryPath('symbols')
    let paths: string[]
    try {
      paths = await scanMarkdownFiles(symbolsDir)
    } catch {
      return []
    }
    const entries = await Promise.all(paths.map((path) => this.readEntry(path).catch(() => null)))
    return entries.filter((entry): entry is MemoryEntry => entry !== null)
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entries = await this.list()
    return entries.find((entry) => entry.id === id) ?? null
  }

  async upsert(input: MemoryUpsertInput): Promise<MemoryEntry> {
    const normalizedPath = normalizeMemoryPath(input.path)
    const fullPath = this.resolveMemoryPath(normalizedPath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, serializeSymbolMemory(input), 'utf-8')
    const entry = await this.readEntry(fullPath)
    if (!entry) throw new Error(`Failed to read symbol memory after write: ${normalizedPath}`)
    return entry
  }

  private resolveMemoryPath(memoryPath: string): string {
    const fullPath = resolve(this.memoryDir, memoryPath)
    const relativePath = relative(resolve(this.memoryDir), fullPath)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Symbol memory path escapes memory dir: ${memoryPath}`)
    }
    return fullPath
  }

  private async readEntry(fullPath: string): Promise<MemoryEntry | null> {
    const raw = await readFile(fullPath, 'utf-8')
    const relativePath = normalizeMemoryPath(relative(resolve(this.memoryDir), fullPath))
    const body = stripFrontmatter(raw)
    const id = frontmatterValue(raw, 'id') ?? relativePath.replace(/\.md$/i, '').replace(/[\\/]+/g, '_')
    return { id, path: relativePath, content: body.trim() }
  }
}

async function scanMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await scanMarkdownFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

function normalizeMemoryPath(memoryPath: string): string {
  const normalized = memoryPath.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error(`Invalid symbol memory path: ${memoryPath}`)
  }
  return normalized
}

function serializeSymbolMemory(input: MemoryUpsertInput): string {
  const lines = [
    '---',
    `id: "${input.id}"`,
    `type: "${input.type}"`,
    `title: "${input.title.replaceAll('"', '\\"')}"`,
    `description: "${input.description.replaceAll('"', '\\"')}"`,
    `keywords: [${input.keywords.map((keyword) => `"${keyword.replaceAll('"', '\\"')}"`).join(', ')}]`,
    `updatedAt: "${input.updatedAt}"`,
    '---',
    '',
    input.body.trimEnd(),
    '',
  ]
  return lines.join('\n')
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw
  const end = raw.indexOf('\n---', 4)
  return end >= 0 ? raw.slice(end + 4).trimStart() : raw
}

function frontmatterValue(raw: string, key: string): string | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return null
  const frontmatter = raw.slice(4, end)
  const match = frontmatter.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))
  return match?.[1] ?? null
}

function normalizeProvider(provider?: string): string | undefined {
  const normalized = provider?.trim()
  return normalized ? normalized.toLowerCase() : undefined
}

/** 根据 interval 决定拉取的日历天数（约 1 倍冗余） */
function getCalendarDays(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 365 // fallback: 1 年

  const n = parseInt(match[1])
  const unit = match[2]

  switch (unit) {
    case 'd': return n * 730   // 日线：2 年
    case 'w': return n * 1825  // 周线：5 年
    case 'h': return n * 90    // 小时线：90 天
    case 'm': return n * 30    // 分钟线：30 天
    default:  return 365
  }
}

function buildStartDate(interval: string): string {
  const calendarDays = getCalendarDays(interval)
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - calendarDays)
  return startDate.toISOString().slice(0, 10)
}

function buildStartDateForLimit(interval: string, limit: number): string {
  const ms = intervalToMs(interval)
  if (!ms) return buildStartDate(interval)
  const startDate = new Date(Date.now() - ms * limit * 2)
  return startDate.toISOString().slice(0, 10)
}

function intervalToMs(interval: string): number | null {
  const match = interval.match(/^(\d+)([mhdw])$/)
  if (!match) return null
  const n = Number(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
  }
  return n * multipliers[unit]
}

function latestClosedCutoff(interval: string, now = new Date()): string | null {
  const ms = intervalToMs(interval)
  if (!ms) return null
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString()
}

function candleDateBeforeCutoff(date: string, cutoff: string): boolean {
  const time = Date.parse(date)
  const cutoffTime = Date.parse(cutoff)
  if (Number.isFinite(time) && Number.isFinite(cutoffTime)) {
    return time < cutoffTime
  }
  return date < cutoff
}

function normalizeCandles(rows: Array<Record<string, unknown>>): NormalizedCandle[] {
  const byDate = new Map<string, NormalizedCandle>()
  for (const row of rows) {
    const date = typeof row.date === 'string' ? row.date : typeof row.time === 'string' ? row.time : ''
    const open = toFiniteNumber(row.open)
    const high = toFiniteNumber(row.high)
    const low = toFiniteNumber(row.low)
    const close = toFiniteNumber(row.close)
    if (!date || open == null || high == null || low == null || close == null) continue
    const volume = toFiniteNumber(row.volume)
    const vwap = toFiniteNumber(row.vwap)
    byDate.set(date, {
      time: date,
      date,
      open,
      high,
      low,
      close,
      volume,
      ...(vwap == null ? {} : { vwap }),
    })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

async function fetchOhlcv(
  params: OhlcvFetchParams,
  equityClient: EquityClientLike,
  cryptoClient: CryptoClientLike,
  currencyClient: CurrencyClientLike,
  commodityClient: CommodityClientLike,
): Promise<OhlcvFetchResult> {
  const warnings: string[] = []
  const provider = normalizeProvider(params.provider)
  const interval = params.asset === 'commodity' && params.interval !== '1d'
    ? '1d'
    : params.interval
  if (params.asset === 'commodity' && params.interval !== '1d') {
    warnings.push('Commodity spot prices only support daily bars; interval was treated as 1d.')
  }

  const request: Record<string, unknown> = {
    symbol: params.symbol,
    interval,
    start_date: params.startDate ?? buildStartDateForLimit(interval, params.limit),
    ...(params.endDate ? { end_date: params.endDate } : {}),
    ...(provider ? { provider } : {}),
  }

  const fetchFromClient = async (query: Record<string, unknown>) => {
    switch (params.asset) {
      case 'equity':
        return await equityClient.getHistorical(query)
      case 'crypto':
        return await cryptoClient.getHistorical(query)
      case 'currency':
        return await currencyClient.getHistorical(query)
      case 'commodity':
        return await commodityClient.getSpotPrices(query)
    }
  }

  const raw = await fetchFromClient(request)

  let candles = normalizeCandles(raw)
  if (!params.includeIncomplete) {
    const cutoff = latestClosedCutoff(interval)
    if (cutoff) candles = candles.filter((bar) => candleDateBeforeCutoff(bar.date, cutoff))
  }
  const limited = candles.slice(-params.limit)
  return {
    asset: params.asset,
    symbol: params.symbol,
    interval,
    provider: params.provider ?? null,
    count: limited.length,
    from: limited[0]?.date ?? '',
    to: limited.at(-1)?.date ?? '',
    truncated: candles.length > limited.length,
    warnings,
    bars: limited,
    error: limited.length === 0 ? {
      code: 'NO_OHLCV_DATA',
      message: `No OHLCV bars available for ${params.symbol} ${interval}.`,
    } : undefined,
  }
}

function summarizeOhlcvResult(result: OhlcvFetchResult) {
  return {
    asset: result.asset,
    symbol: result.symbol,
    interval: result.interval,
    provider: result.provider,
    count: result.count,
    from: result.from,
    to: result.to,
    truncated: result.truncated,
  }
}

function formatLocalTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function localDateSegment(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function createTechnicalAnalysisId(date = new Date()): string {
  const shortUuid = randomUUID().replaceAll('-', '').slice(0, 8)
  return `ta_${formatLocalTimestamp(date)}_${shortUuid}`
}

function validateTechnicalAnalysisId(analysisId: string): void {
  if (!/^ta_\d{8}T\d{6}_[0-9a-f]{8}$/i.test(analysisId)) {
    throw new Error(`Invalid technical analysis id: ${analysisId}`)
  }
}

function technicalAnalysisRelativeArtifactPath(params: {
  analysisId: string
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
  interval: string
  date: string
}): string {
  validateTechnicalAnalysisId(params.analysisId)
  return join(
    safeSegment(params.asset),
    safeSegment(params.symbol),
    safeSegment(params.interval),
    safeSegment(params.date),
    `${params.analysisId}.json`,
  )
}

function technicalAnalysisArtifactPath(relativePath: string): string {
  return join(technicalAnalysisArtifactDir, relativePath)
}

function symbolMemoryRef(asset: z.infer<typeof ohlcvAssetSchema>, symbol: string): SymbolMemoryRef {
  const symbolSafe = safeSegment(symbol.toUpperCase())
  const relativePath = join('symbols', safeSegment(asset), `${symbolSafe}.md`)
  return {
    id: `symbol_memory_${safeSegment(asset)}_${symbolSafe}`,
    path: relativePath,
    relativePath,
    asset,
    symbol: symbol.toUpperCase(),
  }
}

function createSymbolMemoryStore(deps: AnalysisToolDeps = {}): SymbolMemoryStoreLike {
  return new TechnicalAnalysisSymbolMemoryStore(deps.symbolMemoryDir)
}

async function readSymbolMemoryPrior(
  memoryStore: SymbolMemoryStoreLike,
  asset: z.infer<typeof ohlcvAssetSchema>,
  symbol: string,
): Promise<SymbolMemoryPrior> {
  const ref = symbolMemoryRef(asset, symbol)
  try {
    const entry = await memoryStore.get(ref.id)
    return entry
      ? { found: true, id: ref.id, path: ref.path, content: truncateSymbolMemoryContent(entry.content) }
      : { found: false, id: ref.id, path: ref.path }
  } catch (error) {
    return {
      found: false,
      id: ref.id,
      path: ref.path,
      error: {
        code: 'SYMBOL_MEMORY_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function truncateSymbolMemoryContent(content: string, maxChars = 2000): string {
  const trimmed = content.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n\n[truncated]`
}

function findReviewJournal(raw: string): string {
  const markerIndex = raw.indexOf(`\n${symbolMemoryReviewHeading}`)
  if (markerIndex >= 0) return raw.slice(markerIndex + 1).trimEnd()
  if (raw.startsWith(symbolMemoryReviewHeading)) return raw.trimEnd()
  return `${symbolMemoryReviewHeading}\n\n`
}

function extractIntervalSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>()
  const autoStart = raw.indexOf(symbolMemoryAutoStart)
  const autoEnd = raw.indexOf(symbolMemoryAutoEnd)
  if (autoStart < 0 || autoEnd < autoStart) return sections

  const autoBody = raw.slice(autoStart + symbolMemoryAutoStart.length, autoEnd)
  const matches = [...autoBody.matchAll(/^## Interval\s+(.+)$/gm)]
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const interval = match[1].trim()
    const start = match.index ?? 0
    const next = matches[i + 1]
    const end = next?.index ?? autoBody.length
    sections.set(interval, autoBody.slice(start, end).trimEnd())
  }
  return sections
}

function stringifyMemoryValue(value: unknown): string {
  if (value == null) return 'none'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function buildCompactOptionsLines(options: ReturnType<typeof buildTechnicalAnalysisOptionsSummary>): string[] {
  return [
    `- structure: internalLookback=${options.structure.internalLookback}, swingLookback=${options.structure.swingLookback}, useCloseBreak=${options.structure.useCloseBreak}, zoneMode=${options.structure.zoneMode}, fvgMode=${options.structure.fvgMode}, obFilter=${options.structure.obFilter}`,
    `- confluence: emaPeriods=${options.confluence.emaPeriods.join('/')}, vwapEnabled=${options.confluence.vwapEnabled}, vwapAnchor=${options.confluence.vwapAnchor}, fibEnabled=${options.confluence.fib.enabled}, confluenceMinFamilies=${options.confluence.confluenceZone.minFamilies}`,
    `- volume: volumeLookback=${options.volume.volumeLookback}, volumeProfile=${options.volume.volumeProfile.enabled}/${options.volume.volumeProfile.mode}, unusualVolume=${options.volume.unusualVolume.enabled}, stopZone=${options.volume.stopZone.enabled}, vwapDeviation=${options.volume.vwapDeviation.enabled}`,
    `- zones: liquidity=${options.zones.liquidity.enabled}, bpr=${options.zones.bpr.enabled}, maxDistanceAtr=${options.zones.zoneFilter.maxDistanceAtr}, maxZones=${options.zones.zoneFilter.maxZones}, atrPeriod=${options.volatility.atrPeriod}`,
  ]
}

function buildSymbolMemoryAutoBlock(params: {
  artifact: TechnicalAnalysisArtifact
  updatedAt: string
  intervalSections: Map<string, string>
}): string {
  const { artifact, updatedAt, intervalSections } = params
  const ref = symbolMemoryRef(artifact.asset, artifact.symbol)
  const analysis = artifact.analysis
  const view = artifact.summaryView
  const warnings = artifact.warnings.length > 0 ? artifact.warnings : ['none']
  const currentIntervalSection = [
    `## Interval ${artifact.interval}`,
    '',
    `- latestAnalysisId: ${artifact.analysisId}`,
    `- artifactPath: ${artifact.artifactPath}`,
    `- updatedAt: ${updatedAt}`,
    `- range: ${artifact.data.from} -> ${artifact.data.to}`,
    `- trend: ${analysis.summary.trend} / internal ${analysis.summary.internalTrend} / swing ${analysis.summary.swingTrend}`,
    `- latestClose: ${stringifyMemoryValue(analysis.summary.latestClose)}`,
    `- nearestSupport: ${stringifyMemoryValue(analysis.relevance.nearestSupport)}`,
    `- nearestResistance: ${stringifyMemoryValue(analysis.relevance.nearestResistance)}`,
  ].join('\n')
  intervalSections.set(artifact.interval, currentIntervalSection)
  const intervalLines = [...intervalSections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, section]) => ['', section])

  return [
    `# Technical Analysis Memory - ${ref.asset}/${ref.symbol}`,
    '',
    symbolMemoryAutoStart,
    '',
    '## Latest Snapshot',
    '',
    `- updatedAt: ${updatedAt}`,
    `- latestAnalysisId: ${artifact.analysisId}`,
    `- latestArtifactPath: ${artifact.artifactPath}`,
    `- kind: ${artifact.kind}`,
    `- parentAnalysisId: ${artifact.parentAnalysisId ?? 'none'}`,
    `- asset: ${artifact.asset}`,
    `- symbol: ${artifact.symbol}`,
    `- interval: ${artifact.interval}`,
    `- provider: ${artifact.data.provider ?? 'default'}`,
    `- range: ${artifact.data.from} -> ${artifact.data.to}`,
    `- bars: ${artifact.data.count}`,
    `- trend: ${analysis.summary.trend}`,
    `- internalTrend: ${analysis.summary.internalTrend}`,
    `- swingTrend: ${analysis.summary.swingTrend}`,
    `- latestClose: ${stringifyMemoryValue(analysis.summary.latestClose)}`,
    `- nearestSupport: ${stringifyMemoryValue(analysis.relevance.nearestSupport)}`,
    `- nearestResistance: ${stringifyMemoryValue(analysis.relevance.nearestResistance)}`,
    '',
    '## Warnings',
    '',
    ...warnings.map((warning) => `- ${warning}`),
    '',
    '## Effective Options',
    '',
    ...buildCompactOptionsLines(view.effectiveOptions),
    ...intervalLines,
    '',
    symbolMemoryAutoEnd,
  ].join('\n')
}

async function writeSymbolMemorySnapshot(artifact: TechnicalAnalysisArtifact, memoryStore: SymbolMemoryStoreLike): Promise<SymbolMemoryStatus> {
  const updatedAt = new Date().toISOString()
  const ref = symbolMemoryRef(artifact.asset, artifact.symbol)
  return withSymbolMemoryQueue(ref.id, async () => {
    const intervalSections = new Map<string, string>()
    let reviewJournal = `${symbolMemoryReviewHeading}\n\n`
    try {
      const existing = await memoryStore.get(ref.id)
      const existingContent = existing?.content ?? ''
      if (existingContent) reviewJournal = findReviewJournal(existingContent)
      for (const [interval, section] of extractIntervalSections(existingContent)) {
        intervalSections.set(interval, section)
      }
    } catch (error) {
      return {
        updated: false,
        id: ref.id,
        path: ref.path,
        error: {
          code: 'SYMBOL_MEMORY_READ_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    try {
      const autoBlock = buildSymbolMemoryAutoBlock({ artifact, updatedAt, intervalSections })
      await memoryStore.upsert({
        path: ref.relativePath,
        id: ref.id,
        type: 'trading',
        title: `Technical Analysis Memory - ${ref.asset}/${ref.symbol}`,
        description: `Compact per-symbol Technical Analysis memory for ${ref.asset}/${ref.symbol}.`,
        keywords: ['technical-analysis', 'symbol-memory', ref.asset, ref.symbol, artifact.interval],
        updatedAt,
        body: `${autoBlock}\n\n${reviewJournal.trimEnd()}\n`,
      })
      return { updated: true, id: ref.id, path: ref.path }
    } catch (error) {
      return {
        updated: false,
        id: ref.id,
        path: ref.path,
        error: {
          code: 'SYMBOL_MEMORY_WRITE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
}

async function listSymbolMemoryFiles(memoryStore: SymbolMemoryStoreLike): Promise<SymbolMemoryRef[]> {
  const entries = await memoryStore.list()
  const refs = entries
    .map(symbolMemoryRefFromEntry)
    .filter((ref): ref is SymbolMemoryRef => ref !== null)
  return refs.sort((a, b) => `${a.asset}/${a.symbol}`.localeCompare(`${b.asset}/${b.symbol}`))
}

function symbolMemoryRefFromEntry(entry: Pick<MemoryEntry, 'id' | 'path'>): SymbolMemoryRef | null {
  const match = entry.path.match(/^symbols\/(equity|crypto|currency|commodity)\/([^/]+)\.md$/i)
  if (!match || !entry.id.startsWith('symbol_memory_')) return null
  return symbolMemoryRef(match[1] as z.infer<typeof ohlcvAssetSchema>, match[2])
}

async function readSymbolMemoryContent(memoryStore: SymbolMemoryStoreLike, asset: z.infer<typeof ohlcvAssetSchema>, symbol: string) {
  const ref = symbolMemoryRef(asset, symbol)
  try {
    const entry = await memoryStore.get(ref.id)
    if (!entry) {
      return {
        id: ref.id,
        path: ref.path,
        asset: ref.asset,
        symbol: ref.symbol,
        error: {
          code: 'SYMBOL_MEMORY_NOT_FOUND',
          message: `No symbol memory found for ${asset}/${symbol}. Run analyzeTechnicalAnalysis first.`,
        },
      }
    }
    return {
      id: ref.id,
      path: ref.path,
      asset: ref.asset,
      symbol: ref.symbol,
      content: entry.content,
    }
  } catch (error) {
    return {
      id: ref.id,
      path: ref.path,
      asset: ref.asset,
      symbol: ref.symbol,
      error: {
        code: 'SYMBOL_MEMORY_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function appendSymbolReview(params: {
  memoryStore: SymbolMemoryStoreLike
  asset: z.infer<typeof ohlcvAssetSchema>
  symbol: string
  outcome?: z.infer<typeof symbolReviewOutcomeSchema>
  notes: string
  analysisId?: string
}) {
  const ref = symbolMemoryRef(params.asset, params.symbol)
  return withSymbolMemoryQueue(ref.id, async () => {
    const existing = await readSymbolMemoryContent(params.memoryStore, params.asset, params.symbol)
    if ('error' in existing) return existing

    const now = new Date().toISOString()
    const note = [
      '',
      `### ${now}`,
      '',
      `- outcome: ${params.outcome ?? 'pending'}`,
      `- analysisId: ${params.analysisId ?? 'none'}`,
      `- notes: ${params.notes.trim()}`,
    ].join('\n')
    await params.memoryStore.upsert({
      path: ref.relativePath,
      id: ref.id,
      type: 'trading',
      title: `Technical Analysis Memory - ${ref.asset}/${ref.symbol}`,
      description: `Compact per-symbol Technical Analysis memory for ${ref.asset}/${ref.symbol}.`,
      keywords: ['technical-analysis', 'symbol-memory', ref.asset, ref.symbol],
      updatedAt: now,
      body: `${existing.content.trimEnd()}\n${note}\n`,
    })
    return {
      id: ref.id,
      path: ref.path,
      asset: ref.asset,
      symbol: ref.symbol,
      recorded: true,
      outcome: params.outcome ?? 'pending',
      analysisId: params.analysisId ?? null,
    }
  })
}

function withSymbolMemoryQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = symbolMemoryQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  symbolMemoryQueues.set(key, current)
  return current.finally(() => {
    if (symbolMemoryQueues.get(key) === current) {
      symbolMemoryQueues.delete(key)
    }
  })
}

async function loadTechnicalAnalysisIndex(): Promise<TechnicalAnalysisArtifactIndex> {
  try {
    return JSON.parse(await readFile(technicalAnalysisIndexPath, 'utf-8')) as TechnicalAnalysisArtifactIndex
  } catch (error) {
    if (isENOENT(error)) return { version: 1, entries: {} }
    return { version: 1, entries: {} }
  }
}

async function saveTechnicalAnalysisIndex(index: TechnicalAnalysisArtifactIndex): Promise<void> {
  await mkdir(technicalAnalysisArtifactDir, { recursive: true })
  await writeFile(technicalAnalysisIndexPath, JSON.stringify(index, null, 2))
}

async function saveTechnicalAnalysisArtifact(artifact: TechnicalAnalysisArtifact): Promise<void> {
  const artifactPath = technicalAnalysisArtifactPath(artifact.artifactPath)
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(
    artifactPath,
    JSON.stringify(artifact, null, 2),
  )
  const index = await loadTechnicalAnalysisIndex()
  index.entries[artifact.analysisId] = {
    analysisId: artifact.analysisId,
    kind: artifact.kind,
    ...(artifact.parentAnalysisId ? { parentAnalysisId: artifact.parentAnalysisId } : {}),
    relativePath: artifact.artifactPath,
    asset: artifact.asset,
    symbol: artifact.symbol,
    interval: artifact.interval,
    provider: artifact.data.provider,
    createdAt: artifact.createdAt,
    from: artifact.data.from,
    to: artifact.data.to,
  }
  await saveTechnicalAnalysisIndex(index)
}

async function loadTechnicalAnalysisArtifact(analysisId: string): Promise<TechnicalAnalysisArtifact | null> {
  try {
    validateTechnicalAnalysisId(analysisId)
    const index = await loadTechnicalAnalysisIndex()
    const entry = index.entries[analysisId]
    if (!entry) return null
    return JSON.parse(await readFile(technicalAnalysisArtifactPath(entry.relativePath), 'utf-8')) as TechnicalAnalysisArtifact
  } catch (error) {
    if (isENOENT(error)) return null
    if (error instanceof Error && error.message.startsWith('Invalid technical analysis id:')) throw error
    return null
  }
}

function buildTechnicalAnalysisDataView(data: OhlcvFetchResult) {
  return {
    asset: data.asset,
    symbol: data.symbol,
    interval: data.interval,
    provider: data.provider,
    from: data.from,
    to: data.to,
    bars: data.count,
    truncated: data.truncated,
    recentCandles: data.bars.slice(-10),
  }
}

async function runAndSaveTechnicalAnalysis(params: {
  kind: 'baseline' | 'refined'
  parentAnalysisId?: string
  refinementReason?: string
  data: OhlcvFetchResult
  options?: TechnicalAnalysisToolOptions
  deps?: AnalysisToolDeps
}): Promise<TechnicalAnalysisSummaryView> {
  const analyzer = new TechnicalAnalysisAnalyzer()
  const effectiveOptions = normalizeOptions(params.options)
  const analysis = analyzer.analyze(params.data.bars, params.options)
  const createdAtDate = new Date()
  const createdAt = createdAtDate.toISOString()
  const date = localDateSegment(createdAtDate)
  const analysisId = createTechnicalAnalysisId(createdAtDate)
  const artifactPath = technicalAnalysisRelativeArtifactPath({
    analysisId,
    asset: params.data.asset,
    symbol: params.data.symbol,
    interval: params.data.interval,
    date,
  })
  const warnings = [...params.data.warnings, ...analysis.warnings]
  let symbolMemory: SymbolMemoryStatus | undefined
  const symbolMemoryStore = createSymbolMemoryStore(params.deps)
  const symbolMemoryPrior = await readSymbolMemoryPrior(symbolMemoryStore, params.data.asset, params.data.symbol)
  const artifactBase = {
    analysisId,
    kind: params.kind,
    parentAnalysisId: params.parentAnalysisId,
    refinementReason: params.refinementReason,
    data: params.data,
    warnings,
    analysis,
    requestedOptions: params.options,
  }
  let summaryView = buildTechnicalAnalysisSummaryView(artifactBase)
  const artifact: TechnicalAnalysisArtifact = {
    analysisId,
    kind: params.kind,
    ...(params.parentAnalysisId ? { parentAnalysisId: params.parentAnalysisId } : {}),
    ...(params.refinementReason ? { refinementReason: params.refinementReason } : {}),
    createdAt,
    artifactPath,
    asset: params.data.asset,
    symbol: params.data.symbol,
    interval: params.data.interval,
    date,
    data: summarizeOhlcvResult(params.data),
    warnings,
    bars: params.data.bars,
    ...(params.options ? { requestedOptions: params.options } : {}),
    effectiveOptions,
    analysis,
    summaryView,
  }
  symbolMemory = await writeSymbolMemorySnapshot(artifact, symbolMemoryStore)
  summaryView = { ...summaryView, symbolMemory: { ...symbolMemory, prior: symbolMemoryPrior } }
  artifact.summaryView = summaryView
  await saveTechnicalAnalysisArtifact(artifact)
  return summaryView
}

function buildTechnicalAnalysisSummaryView(params: {
  analysisId: string
  kind: 'baseline' | 'refined'
  parentAnalysisId?: string
  refinementReason?: string
  data: OhlcvFetchResult
  warnings: string[]
  analysis: TechnicalAnalysisAnalysis
  requestedOptions?: TechnicalAnalysisToolOptions
}): TechnicalAnalysisSummaryView {
  const { analysisId, kind, parentAnalysisId, refinementReason, data, warnings, analysis, requestedOptions } = params
  const effectiveOptions = normalizeOptions(requestedOptions)
  return {
    analysisId,
    kind,
    ...(parentAnalysisId ? { parentAnalysisId } : {}),
    ...(refinementReason ? { refinementReason } : {}),
    data: buildTechnicalAnalysisDataView(data),
    summary: {
      trend: analysis.summary.trend,
      internalTrend: analysis.summary.internalTrend,
      swingTrend: analysis.summary.swingTrend,
      latestClose: analysis.summary.latestClose,
      nearestSupport: analysis.relevance.nearestSupport,
      nearestResistance: analysis.relevance.nearestResistance,
      warnings,
    },
    ...(requestedOptions ? { requestedOptions } : {}),
    effectiveOptions: buildTechnicalAnalysisOptionsSummary(effectiveOptions),
    optionPlaybook: buildTechnicalAnalysisOptionPlaybook(analysisId),
    topSignals: buildTopTechnicalSignals(analysis),
    sections: {
      structure: {
        description: 'Pivots, MSS/BOS structure events, EQH/EQL, and strong/weak levels.',
        defaultLimit: 50,
      },
      zones: {
        description: 'Relevant support/resistance zones, order blocks, FVG/IFVG, liquidity, BPR, and confluence zones.',
        defaultLimit: 50,
      },
      volume: {
        description: 'Volume-price confirmations, unusual volume, volume profile, VWAP deviation, and stop-run evidence.',
        defaultLimit: 50,
      },
      confluence: {
        description: 'EMA/VWAP/FIB context, VWAP deviation, and confluence zones.',
        defaultLimit: 50,
      },
      candles: {
        description: 'Recent OHLCV candles from the stored analysis artifact.',
        defaultLimit: 10,
      },
      raw: {
        description: 'Trimmed raw analyzer arrays for debugging and replay.',
        defaultLimit: 50,
      },
    },
    nextActions: kind === 'baseline'
      ? buildTechnicalAnalysisRefineActions(analysisId)
      : buildTechnicalAnalysisSectionActions(analysisId),
  }
}

function buildTechnicalAnalysisRefineActions(analysisId: string): TechnicalAnalysisSummaryView['nextActions'] {
  return buildTechnicalAnalysisOptionPlaybook(analysisId).map((entry) => ({
    tool: 'refineTechnicalAnalysis',
    input: entry.input,
    when: entry.when,
  }))
}

function buildTechnicalAnalysisSectionActions(analysisId: string): TechnicalAnalysisSummaryView['nextActions'] {
  return [
    {
      tool: 'readTechnicalAnalysisSection',
      input: { analysisId, section: 'structure' },
      when: 'Need the detailed MSS/BOS path, pivot context, or strong/weak level evidence from this refined analysis.',
    },
    {
      tool: 'readTechnicalAnalysisSection',
      input: { analysisId, section: 'zones' },
      when: 'Need detailed support/resistance, OB, FVG, liquidity, BPR, or confluence zone evidence from this refined analysis.',
    },
    {
      tool: 'readTechnicalAnalysisSection',
      input: { analysisId, section: 'volume' },
      when: 'Need volume confirmation, unusual volume, VP/POC/VA/Void, VWAP deviation, or stop-run details from this refined analysis.',
    },
    {
      tool: 'readTechnicalAnalysisSection',
      input: { analysisId, section: 'candles', limit: 20 },
      when: 'Need more candles than the default 10-candle summary from this refined analysis.',
    },
  ]
}

function buildTechnicalAnalysisOptionsSummary(options: ReturnType<typeof normalizeOptions>) {
  return {
    structure: {
      internalLookback: options.internalLookback,
      swingLookback: options.swingLookback,
      useCloseBreak: options.useCloseBreak,
      zoneMode: options.zoneMode,
      fvgMode: options.fvgMode,
      obFilter: options.obFilter,
      obMitigation: options.obMitigation,
      obPosition: options.obPosition,
    },
    confluence: {
      emaPeriods: [options.emaFastPeriod, options.emaSlowPeriod, options.emaLongPeriod],
      vwapEnabled: options.vwapEnabled,
      vwapAnchor: options.vwapAnchor,
      fib: options.fib,
      confluenceZone: options.confluenceZone,
    },
    volume: {
      volumeLookback: options.volumeLookback,
      volumeProfile: options.volumeProfile,
      unusualVolume: options.unusualVolume,
      stopZone: options.stopZone,
      vwapDeviation: options.vwapDeviation,
    },
    zones: {
      liquidity: options.liquidity,
      bpr: options.bpr,
      zoneFilter: options.zoneFilter,
      maxOrderBlocks: options.maxOrderBlocks,
      limits: options.limits,
    },
    volatility: {
      atrPeriod: options.atrPeriod,
      equalToleranceAtr: options.equalToleranceAtr,
    },
  }
}

function buildTechnicalAnalysisOptionPlaybook(analysisId: string): TechnicalAnalysisRefineAction[] {
  return [
    {
      lens: 'ema_trend_filter',
      when: 'User asks for trend filter, golden/death cross context, or 20/50/200 EMA alignment.',
      tool: 'refineTechnicalAnalysis',
      input: {
        analysisId,
        reason: 'Refine with common higher-timeframe EMA trend filters.',
        options: { emaFastPeriod: 20, emaSlowPeriod: 50, emaLongPeriod: 200 },
      },
    },
    {
      lens: 'anchored_vwap',
      when: 'User asks about VWAP position, anchored VWAP, session VWAP, monthly VWAP, or mean reversion around VWAP.',
      tool: 'refineTechnicalAnalysis',
      input: {
        analysisId,
        reason: 'Refine with explicit VWAP anchor and deviation bands.',
        options: { vwapAnchor: 'month', vwapDeviation: { enabled: true, bandLookback: 50, signalEnabled: true } },
      },
    },
    {
      lens: 'liquidity_and_imbalances',
      when: 'User asks about OB/FVG/IFVG, liquidity sweeps, support/resistance relevance, or supply/demand zones.',
      tool: 'refineTechnicalAnalysis',
      input: {
        analysisId,
        reason: 'Refine with IFVG, MSS-filtered order blocks, and wider relevant-zone search.',
        options: {
          fvgMode: 'IFVG',
          obFilter: 'MSS',
          liquidity: { minClusterSize: 2 },
          zoneFilter: { maxDistanceAtr: 6, includeFilledFairValueGaps: true },
        },
      },
    },
    {
      lens: 'volume_profile',
      when: 'User asks about POC, value area, volume voids, auction context, or volume-at-price structure.',
      tool: 'refineTechnicalAnalysis',
      input: {
        analysisId,
        reason: 'Refine with a wider rolling volume profile.',
        options: { volumeProfile: { mode: 'rolling', lookback: 500, bins: 120, valueAreaPercent: 70 } },
      },
    },
    {
      lens: 'custom_fibonacci',
      when: 'User asks for specific Fibonacci retracements or confluence around 23.6/38.2/50/61.8/78.6 levels.',
      tool: 'refineTechnicalAnalysis',
      input: {
        analysisId,
        reason: 'Refine with explicit Fibonacci levels.',
        options: { fib: { levels: [0.236, 0.382, 0.5, 0.618, 0.786] } },
      },
    },
  ]
}

function buildTopTechnicalSignals(analysis: TechnicalAnalysisAnalysis): Array<Record<string, unknown>> {
  const signalItems = analysis.volumePriceSignals
    .toSorted((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, 8)
    .map((signal) => ({
      type: 'volume_price_signal',
      id: signal.id,
      kind: signal.kind,
      time: signal.time,
      direction: signal.direction,
      score: signal.score,
      confluenceScore: signal.confluenceScore,
      message: signal.message,
    }))

  if (signalItems.length >= 5) return signalItems

  const structureItems = analysis.structureEvents
    .slice(-5)
    .reverse()
    .map((event) => ({
      type: 'structure_event',
      id: event.id,
      kind: event.type,
      level: event.level,
      time: event.time,
      direction: event.direction,
      breakPrice: event.breakPrice,
      volumeConfirmation: event.volumeConfirmation,
    }))

  const zoneItems = analysis.relevance.zones
    .slice(0, 5)
    .map((zone) => ({
      type: 'relevant_zone',
      id: zone.id,
      kind: zone.kind,
      time: zone.time,
      direction: zone.direction,
      top: zone.top,
      bottom: zone.bottom,
      distanceAtr: zone.distanceAtr,
      status: zone.status,
    }))

  return [...signalItems, ...structureItems, ...zoneItems].slice(0, 8)
}

function normalizeTechnicalAnalysisSectionLimit(
  section: z.infer<typeof technicalAnalysisSectionSchema>,
  limit?: number,
): number {
  const defaultLimit = section === 'candles' ? 10 : section === 'raw' ? 50 : 50
  const maxLimit = section === 'candles' ? 100 : section === 'raw' ? 200 : 200
  return Math.min(maxLimit, Math.max(1, limit ?? defaultLimit))
}

function readTechnicalAnalysisSectionFromArtifact(
  artifact: TechnicalAnalysisArtifact,
  section: z.infer<typeof technicalAnalysisSectionSchema>,
  requestedLimit?: number,
) {
  const limit = normalizeTechnicalAnalysisSectionLimit(section, requestedLimit)
  const analysis = artifact.analysis

  switch (section) {
    case 'structure':
      return {
        analysisId: artifact.analysisId,
        section,
        limit,
        summary: {
          trend: analysis.summary.trend,
          internalTrend: analysis.summary.internalTrend,
          swingTrend: analysis.summary.swingTrend,
          structureEvents: analysis.summary.structureEvents,
          equalHighLows: analysis.summary.equalHighLows,
        },
        pivots: analysis.pivots.slice(-limit),
        structureEvents: analysis.structureEvents.slice(-limit),
        equalHighLows: analysis.equalHighLows.slice(-limit),
        strongWeakLevels: analysis.strongWeakLevels.slice(-limit),
      }
    case 'zones':
      return {
        analysisId: artifact.analysisId,
        section,
        limit,
        latestClose: analysis.relevance.latestClose,
        nearestSupport: analysis.relevance.nearestSupport,
        nearestResistance: analysis.relevance.nearestResistance,
        zones: analysis.relevance.zones.slice(0, limit),
        orderBlocks: analysis.relevance.orderBlocks.slice(0, limit),
        fairValueGaps: analysis.relevance.fairValueGaps.slice(0, limit),
        liquidityZones: analysis.relevance.liquidityZones.slice(0, limit),
        balancePriceRanges: analysis.relevance.balancePriceRanges.slice(0, limit),
        confluenceZones: analysis.relevance.confluenceZones.slice(0, limit),
        premiumDiscount: analysis.premiumDiscount,
        filteredSummary: analysis.relevance.filteredSummary,
      }
    case 'volume':
      return {
        analysisId: artifact.analysisId,
        section,
        limit,
        volumePriceSignals: analysis.volumePriceSignals.slice(-limit),
        unusualVolumeSignals: analysis.volumePriceSignals
          .filter((signal) => signal.kind === 'unusual_volume')
          .slice(-limit),
        volumeProfiles: analysis.volumeProfiles.slice(-limit),
        stopZones: analysis.stopZones.slice(-limit),
        vwapDeviation: analysis.vwapDeviation,
      }
    case 'confluence':
      return {
        analysisId: artifact.analysisId,
        section,
        limit,
        confluence: analysis.summary.confluence,
        vwapDeviation: analysis.vwapDeviation,
        fibRetracements: analysis.fibRetracements.slice(-limit),
        confluenceZones: analysis.confluenceZones.slice(-limit),
        relevantConfluenceZones: analysis.relevance.confluenceZones.slice(0, limit),
      }
    case 'candles':
      return {
        analysisId: artifact.analysisId,
        section,
        limit,
        data: artifact.data,
        candles: artifact.bars.slice(-limit),
      }
    case 'raw':
      return {
        analysisId: artifact.analysisId,
        section,
        limit,
        summary: analysis.summary,
        warnings: analysis.warnings,
        pivots: analysis.pivots.slice(-limit),
        structureEvents: analysis.structureEvents.slice(-limit),
        orderBlocks: analysis.orderBlocks.slice(-limit),
        fairValueGaps: analysis.fairValueGaps.slice(-limit),
        liquidityZones: analysis.liquidityZones.slice(-limit),
        balancePriceRanges: analysis.balancePriceRanges.slice(-limit),
        fibRetracements: analysis.fibRetracements.slice(-limit),
        confluenceZones: analysis.confluenceZones.slice(-limit),
        volumeProfiles: analysis.volumeProfiles.slice(-limit),
        stopZones: analysis.stopZones.slice(-limit),
        equalHighLows: analysis.equalHighLows.slice(-limit),
        accumulationDistributionZones: analysis.accumulationDistributionZones.slice(-limit),
        premiumDiscount: analysis.premiumDiscount,
        strongWeakLevels: analysis.strongWeakLevels.slice(-limit),
        vwapDeviation: analysis.vwapDeviation,
        volumePriceSignals: analysis.volumePriceSignals.slice(-limit),
        relevance: {
          ...analysis.relevance,
          orderBlocks: analysis.relevance.orderBlocks.slice(0, limit),
          fairValueGaps: analysis.relevance.fairValueGaps.slice(0, limit),
          liquidityZones: analysis.relevance.liquidityZones.slice(0, limit),
          balancePriceRanges: analysis.relevance.balancePriceRanges.slice(0, limit),
          confluenceZones: analysis.relevance.confluenceZones.slice(0, limit),
          zones: analysis.relevance.zones.slice(0, limit),
        },
      }
  }
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.=-]+/g, '_') || '_'
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function buildContext(
  asset: 'equity' | 'crypto' | 'currency' | 'commodity',
  equityClient: EquityClientLike,
  cryptoClient: CryptoClientLike,
  currencyClient: CurrencyClientLike,
  commodityClient: CommodityClientLike,
): IndicatorContext {
  return {
    getHistoricalData: async (symbol, interval): Promise<HistoricalDataResult> => {
      const start_date = buildStartDate(interval)

      let raw: Array<Record<string, unknown>>
      switch (asset) {
        case 'equity':
          raw = await equityClient.getHistorical({ symbol, start_date, interval })
          break
        case 'crypto':
          raw = await cryptoClient.getHistorical({ symbol, start_date, interval })
          break
        case 'currency':
          raw = await currencyClient.getHistorical({ symbol, start_date, interval })
          break
        case 'commodity':
          raw = await commodityClient.getSpotPrices({ symbol, start_date })
          break
      }

      // Filter out bars with null OHLC (yfinance returns null for incomplete/missing data)
      const data = raw.filter(
        (d): d is Record<string, unknown> & OhlcvData =>
          d.close != null && d.open != null && d.high != null && d.low != null,
      ) as OhlcvData[]

      data.sort((a, b) => a.date.localeCompare(b.date))

      const meta: DataSourceMeta = {
        symbol,
        from: data.length > 0 ? data[0].date : '',
        to: data.length > 0 ? data[data.length - 1].date : '',
        bars: data.length,
      }

      return { data, meta }
    },
  }
}

export function createAnalysisTools(
  equityClient: EquityClientLike,
  cryptoClient: CryptoClientLike,
  currencyClient: CurrencyClientLike,
  commodityClient: CommodityClientLike,
  deps: AnalysisToolDeps = {},
) {
  return {
    getOHLCV: tool({
      description: `Fetch raw OHLCV candles for analysis.

Use this when the user asks for recent candles or K-line data and needs raw OHLCV separate from technical analysis. The result is sorted ascending.

Examples:
  getOHLCV({ asset: "equity", symbol: "QQQ", interval: "5m", limit: 200 })
  getOHLCV({ asset: "crypto", symbol: "BTCUSD", interval: "1h", limit: 300 })

Returns { bars, count, from, to, asset, symbol, interval, provider, warnings }.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol, e.g. QQQ, AAPL, BTCUSD, EURUSD, gold'),
        interval: z.string().min(1).default('1d').describe("Candle interval, e.g. '5m', '15m', '1h', '1d'. Commodities use 1d."),
        limit: z.number().int().min(1).max(1000).default(200).describe('Number of latest candles to return (default 200, max 1000)'),
        startDate: z.string().optional().describe('Optional inclusive start date/time passed to provider'),
        endDate: z.string().optional().describe('Optional inclusive end date/time passed to provider'),
        provider: z.string().optional().describe('Optional provider override supported by the current market-data backend'),
        includeIncomplete: z.boolean().default(false).describe('Include the current incomplete candle when provider returns it'),
      }),
      execute: async ({ asset, symbol, interval, limit, startDate, endDate, provider, includeIncomplete }) => {
        return await fetchOhlcv(
          { asset, symbol, interval, limit, startDate, endDate, provider, includeIncomplete },
          equityClient,
          cryptoClient,
          currencyClient,
          commodityClient,
        )
      },
    }),
    analyzeTechnicalAnalysis: tool({
      description: `Fetch OHLCV candles for a symbol/timeframe and run deterministic technical analysis.

Use this as the preferred tool when the user asks for technical analysis, market structure, MSS/BOS, FVG, OB, liquidity, fibonacci levels, confluence zones, supply/demand, VWAP, EMA, or volume-price analysis by symbol and timeframe.

Tune options when the user asks for a specific lens: set vwapAnchor for VWAP anchor questions, EMA periods for trend filters, fib.levels for custom retracements, volumeProfile for POC/VA/void analysis, liquidity/zoneFilter for support-resistance relevance, and internalLookback/swingLookback/useCloseBreak for structure sensitivity.

Examples:
- VWAP session context: options { vwapAnchor: "session", vwapDeviation: { enabled: true, bandLookback: 50 } }
- Higher-timeframe trend filter: options { emaFastPeriod: 20, emaSlowPeriod: 50, emaLongPeriod: 200, swingLookback: 80 }
- Liquidity/OB/FVG review: options { fvgMode: "IFVG", obFilter: "MSS", liquidity: { minClusterSize: 2 }, zoneFilter: { maxDistanceAtr: 6 } }
- Volume profile: options { volumeProfile: { mode: "rolling", lookback: 500, bins: 120, valueAreaPercent: 70 } }

The default response is context-efficient: it returns a baseline summary, top signals, recent candles, optionPlaybook, section names, and an analysisId such as ta_20260509T164312_a1b2c3d4. Full analyzer output and full OHLCV bars are stored locally under data/cache/technical-analysis/{asset}/{symbol}/{interval}/{date}. Use refineTechnicalAnalysis to rerun the same bars with chosen options, then readTechnicalAnalysisSection for details.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol, e.g. QQQ, AAPL, BTCUSD, EURUSD, gold'),
        interval: z.string().min(1).default('1d').describe("Candle interval, e.g. '5m', '15m', '1h', '1d'. Commodities use 1d."),
        limit: z.number().int().min(1).max(1000).default(300).describe('Number of latest candles to analyze (default 300, max 1000)'),
        provider: z.string().optional().describe('Optional provider override supported by the current market-data backend'),
        includeIncomplete: z.boolean().default(false).describe('Include the current incomplete candle when provider returns it'),
        options: technicalAnalysisOptionsSchema.optional().describe('Fine-grained detector options. Pass only the fields needed for the user question; omitted fields use analyzer defaults.'),
      }),
      execute: async ({ asset, symbol, interval, limit, provider, includeIncomplete, options }) => {
        const data = await fetchOhlcv(
          { asset, symbol, interval, limit, provider, includeIncomplete },
          equityClient,
          cryptoClient,
          currencyClient,
          commodityClient,
        )
        if (data.error) {
          return {
            data: summarizeOhlcvResult(data),
            warnings: data.warnings,
            error: data.error,
          }
        }

        return await runAndSaveTechnicalAnalysis({ kind: 'baseline', data, options, deps })
      },
    }),
    refineTechnicalAnalysis: tool({
      description: `Rerun technical analysis for an existing analysisId using the stored OHLCV bars and a new options object.

Use this as Step 2 after analyzeTechnicalAnalysis when the baseline summary suggests a specific lens, such as EMA trend filters, anchored VWAP, liquidity/IFVG review, volume profile, or custom Fibonacci levels. This does not call the market-data provider again; it creates a refined artifact with a new analysisId and parentAnalysisId.`,
      inputSchema: z.object({
        analysisId: z.string().min(1).describe('Parent analysis id returned by analyzeTechnicalAnalysis, e.g. ta_20260509T164312_a1b2c3d4'),
        options: technicalAnalysisOptionsSchema.describe('Fine-grained detector options for the refined analysis. Pass the smallest option object needed for the chosen lens.'),
        reason: z.string().min(1).max(500).optional().describe('Short reason for the refinement, e.g. "monthly VWAP and 20/50/200 EMA confluence"'),
      }),
      execute: async ({ analysisId, options, reason }) => {
        let parent: TechnicalAnalysisArtifact | null
        try {
          parent = await loadTechnicalAnalysisArtifact(analysisId)
        } catch (error) {
          return {
            parentAnalysisId: analysisId,
            error: {
              code: 'INVALID_ANALYSIS_ID',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        if (!parent) {
          return {
            parentAnalysisId: analysisId,
            error: {
              code: 'TECHNICAL_ANALYSIS_ARTIFACT_NOT_FOUND',
              message: `No stored technical analysis artifact found for ${analysisId}. Run analyzeTechnicalAnalysis again.`,
            },
          }
        }
        const data: OhlcvFetchResult = {
          asset: parent.asset,
          symbol: parent.symbol,
          interval: parent.interval,
          provider: parent.data.provider,
          count: parent.bars.length,
          from: parent.data.from,
          to: parent.data.to,
          truncated: parent.data.truncated,
          warnings: parent.warnings,
          bars: parent.bars,
        }
        return await runAndSaveTechnicalAnalysis({
          kind: 'refined',
          parentAnalysisId: parent.analysisId,
          refinementReason: reason,
          data,
          options,
          deps,
        })
      },
    }),
    listSymbolMemories: tool({
      description: `List Technical Analysis symbol memories stored under data/brain/memory/symbols.

Use this to discover symbols that already have compact analysis memory and review journals.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.optional().describe('Optional asset filter'),
        symbol: z.string().optional().describe('Optional symbol filter'),
      }),
      execute: async ({ asset, symbol }) => {
        const memoryStore = createSymbolMemoryStore(deps)
        const symbolFilter = symbol ? safeSegment(symbol.toUpperCase()) : undefined
        const refs = (await listSymbolMemoryFiles(memoryStore))
          .filter((ref) => !asset || ref.asset === asset)
          .filter((ref) => !symbolFilter || ref.symbol === symbolFilter)
        return {
          count: refs.length,
          memories: refs.map((ref) => ({
            id: ref.id,
            path: ref.path,
            asset: ref.asset,
            symbol: ref.symbol,
          })),
        }
      },
    }),
    readSymbolMemory: tool({
      description: `Read one compact Technical Analysis symbol memory and its Review Journal.

This returns the markdown memory content for a symbol. It does not expose full raw OHLCV candles.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol, e.g. QQQ, AAPL, BTCUSD, EURUSD, gold'),
      }),
      execute: async ({ asset, symbol }) => {
        return await readSymbolMemoryContent(createSymbolMemoryStore(deps), asset, symbol)
      },
    }),
    recordSymbolReview: tool({
      description: `Append a review note to a Technical Analysis symbol memory Review Journal.

Use this after the market has played out or after manual review. The note is appended; the compact automatic snapshot is preserved.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol, e.g. QQQ, AAPL, BTCUSD, EURUSD, gold'),
        outcome: symbolReviewOutcomeSchema.optional().describe('Optional review outcome'),
        notes: z.string().min(1).max(2000).describe('Review note to append'),
        analysisId: z.string().optional().describe('Optional analysis id this review refers to'),
      }),
      execute: async ({ asset, symbol, outcome, notes, analysisId }) => {
        if (analysisId) {
          try {
            validateTechnicalAnalysisId(analysisId)
          } catch (error) {
            return {
              asset,
              symbol,
              analysisId,
              error: {
                code: 'INVALID_ANALYSIS_ID',
                message: error instanceof Error ? error.message : String(error),
              },
            }
          }
        }
        return await appendSymbolReview({ memoryStore: createSymbolMemoryStore(deps), asset, symbol, outcome, notes, analysisId })
      },
    }),
    readTechnicalAnalysisSection: tool({
      description: `Read a stored technical-analysis artifact section by analysisId.

Use this only after analyzeTechnicalAnalysis when the summary is insufficient. Prefer focused sections over raw. The candles section returns at most 100 candles; raw returns trimmed analyzer arrays for debugging with a max limit of 200.`,
      inputSchema: z.object({
        analysisId: z.string().min(1).describe('Analysis id returned by analyzeTechnicalAnalysis, e.g. ta_20260509T164312_a1b2c3d4'),
        section: technicalAnalysisSectionSchema.describe('Section to read: structure, zones, volume, confluence, candles, or raw'),
        limit: z.number().int().min(1).max(500).optional().describe('Optional item limit. Section-specific caps are applied.'),
      }),
      execute: async ({ analysisId, section, limit }) => {
        let artifact: TechnicalAnalysisArtifact | null
        try {
          artifact = await loadTechnicalAnalysisArtifact(analysisId)
        } catch (error) {
          return {
            analysisId,
            section,
            error: {
              code: 'INVALID_ANALYSIS_ID',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        if (!artifact) {
          return {
            analysisId,
            section,
            error: {
              code: 'TECHNICAL_ANALYSIS_ARTIFACT_NOT_FOUND',
              message: `No stored technical analysis artifact found for ${analysisId}. Run analyzeTechnicalAnalysis again.`,
            },
          }
        }
        return readTechnicalAnalysisSectionFromArtifact(artifact, section, limit)
      },
    }),
    calculateIndicator: tool({
      description: `Calculate technical indicators for any asset using formula expressions.

Asset classes: "equity" for stocks, "crypto" for cryptocurrencies, "currency" for forex pairs, "commodity" for commodities (use canonical names: gold, crude_oil, copper, etc.).

Data access (returns array — use [-1] for latest value):
  CLOSE('AAPL', '1d'), HIGH, LOW, OPEN, VOLUME — args: symbol, interval (e.g. '1d', '1w', '1h').
  CLOSE('AAPL', '1d')[-1] → latest close price as a single number.

Statistics (returns a single number — do NOT use [-1]):
  SMA(data, period), EMA, STDEV, MAX, MIN, SUM, AVERAGE.

Technical (returns a single number or object — do NOT use [-1]):
  RSI(data, 14) → number.  BBANDS(data, 20, 2) → {upper, middle, lower}.
  MACD(data, 12, 26, 9) → {macd, signal, histogram}.  ATR(highs, lows, closes, 14) → number.

Arithmetic: +, -, *, / operators between numbers. E.g. CLOSE(...)[-1] - SMA(..., 50).

Examples:
  SMA(CLOSE('AAPL', '1d'), 50)              → equity 50-day moving average
  RSI(CLOSE('BTCUSD', '1d'), 14)            → crypto RSI (single number, no [-1])
  CLOSE('EURUSD', '1d')[-1]                 → latest forex close (needs [-1])
  CLOSE('gold', '1d')[-1]                   → latest gold price (canonical name)

Returns { value, dataRange } where dataRange shows the actual date span of the data used.
Use marketSearchForResearch to find the correct symbol first.`,
      inputSchema: z.object({
        asset: z.enum(['equity', 'crypto', 'currency', 'commodity']).describe('Asset class'),
        formula: z.string().describe("Formula expression, e.g. SMA(CLOSE('AAPL', '1d'), 50)"),
        precision: z.number().int().min(0).max(10).optional().describe('Decimal places (default: 4)'),
      }),
      execute: async ({ asset, formula, precision }) => {
        const context = buildContext(asset, equityClient, cryptoClient, currencyClient, commodityClient)
        const calculator = new IndicatorCalculator(context)
        return await calculator.calculate(formula, precision)
      },
    }),
  }
}
