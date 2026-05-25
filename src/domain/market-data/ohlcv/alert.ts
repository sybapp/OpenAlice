import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventLogEntry } from '../../../core/event-log.js'
import type { ConnectorCenter } from '../../../core/connector-center.js'
import type { Listener, ListenerContext } from '../../../core/listener.js'
import type { ListenerRegistry } from '../../../core/listener-registry.js'
import { createPump, type Pump } from '../../../core/pump.js'
import type { CronFirePayload } from '../../../task/cron/engine.js'
import type { CronEngine } from '../../../task/cron/engine.js'
import { TechnicalAnalysisAnalyzer } from '../../../domain/analysis/technical-analysis/analyzer.js'
import type {
  TechnicalAnalysisAnalysis,
  TechnicalAnalysisCandle,
  TechnicalAnalysisOptions,
  TechnicalAnalysisRelevantZone,
  StructureEvent,
  VolumePriceSignal,
} from '../../../domain/analysis/technical-analysis/types.js'
import type { CommodityClientLike, CryptoClientLike, CurrencyClientLike, EquityClientLike } from '../client/types.js'
import type { OhlcvCacheService } from './cache-service.js'
import { MarketDataAlertRunStore } from './run-store.js'
import type { MarketDataAlertConfig, MarketDataAlertItem, MarketDataAlertMode, MarketDataAlertRunRecord, MarketDataAlertWorkspaceExecution } from './types.js'

export const MARKET_DATA_ALERT_JOB_NAME = '__market_data_alert__'

const ALERT_EMITS = ['agent.work.requested'] as const
type AlertEmits = typeof ALERT_EMITS

export interface MarketDataAlertSignal {
  id: string
  kind: 'structure' | 'zone' | 'volume' | 'liquidity' | 'bpr' | 'confluence' | 'vp_level' | 'vwap_deviation' | 'stop_run' | 'unusual_volume' | 'ifvg'
  label: string
  direction?: 'bullish' | 'bearish'
  index: number
  time: string | number
  price?: number
  message: string
  volumeConfirmation?: 'confirmed' | 'weak' | 'unavailable'
  score?: number
  confluenceScore?: number
}

export interface MarketDataAlertItemResult {
  asset: MarketDataAlertItem['asset']
  symbol: string
  interval: string
  provider?: string
  mode: MarketDataAlertMode
  ok: boolean
  skipped?: boolean
  reason?: string
  signals: MarketDataAlertSignal[]
  notified: boolean
  taskRequested: boolean
  workspaceExecution?: MarketDataAlertWorkspaceExecution
  latestClose?: number
  error?: string
}

export interface MarketDataAlertRunResult {
  enabled: boolean
  skipped: boolean
  reason?: 'disabled' | 'already_processing'
  every: string
  itemCount: number
  results: MarketDataAlertItemResult[]
  startedAt: string
  finishedAt: string
}

export interface MarketDataAlertScheduler {
  start(): Promise<void>
  stop(): void
  runOnce(): Promise<MarketDataAlertRunResult>
  readonly listener: Listener<'cron.fire', AlertEmits>
}

interface AlertState {
  seenSignals: Record<string, number>
}

interface StateStore {
  read(): Promise<AlertState>
  write(state: AlertState): Promise<void>
}

export function createMarketDataAlertScheduler(deps: {
  config: MarketDataAlertConfig
  readConfig?: () => Promise<MarketDataAlertConfig>
  cronEngine: CronEngine
  registry: ListenerRegistry
  connectorCenter: ConnectorCenter
  cacheService: OhlcvCacheService
  requestTask?: (prompt: string) => Promise<void>
  runWorkspaceTask?: (input: {
    item: MarketDataAlertItem
    prompt: string
    timeoutMs: number
    agent?: 'workspace-default' | 'claude' | 'codex'
    resume?: 'auto' | 'fresh' | 'last'
    workspaceId?: string
  }) => Promise<{ ok: boolean; skipped?: boolean; error?: string; workspaceId?: string; agent?: string; output?: string }>
  statePath?: string
  runsPath?: string
  feedbackPath?: string
  now?: () => number
  clients: {
    equity: EquityClientLike
    crypto: CryptoClientLike
    currency: CurrencyClientLike
    commodity: CommodityClientLike
  }
}): MarketDataAlertScheduler {
  const { config, cronEngine, registry, connectorCenter, cacheService, clients } = deps
  const readConfig = deps.readConfig ?? (async () => config)
  const now = deps.now ?? Date.now
  const stateStore = createJsonStateStore(deps.statePath ?? 'data/cache/market-data-alerts/state.json')
  const runStore = new MarketDataAlertRunStore(deps.runsPath, deps.feedbackPath)
  const analyzer = new TechnicalAnalysisAnalyzer()
  let processing = false
  let registered = false
  let pump: Pump | null = null

  async function handleFire(
    entry: EventLogEntry<CronFirePayload>,
    ctx: ListenerContext<AlertEmits>,
  ): Promise<void> {
    if (entry.payload.jobName !== MARKET_DATA_ALERT_JOB_NAME) return
    await runOnce(ctx)
  }

  async function runOnce(ctx?: ListenerContext<AlertEmits>): Promise<MarketDataAlertRunResult> {
    const startedAt = new Date(now()).toISOString()
    const latestConfig = await readConfig()
    if (!latestConfig.enabled) {
      const result: MarketDataAlertRunResult = {
        enabled: false,
        skipped: true,
        reason: 'disabled',
        every: latestConfig.every,
        itemCount: latestConfig.items.length,
        results: [],
        startedAt,
        finishedAt: new Date(now()).toISOString(),
      }
      await recordRunResult(result)
      return result
    }
    if (processing) {
      const result: MarketDataAlertRunResult = {
        enabled: true,
        skipped: true,
        reason: 'already_processing',
        every: latestConfig.every,
        itemCount: latestConfig.items.length,
        results: [],
        startedAt,
        finishedAt: new Date(now()).toISOString(),
      }
      await recordRunResult(result)
      return result
    }

    processing = true
    const results: MarketDataAlertItemResult[] = []
    try {
      const state = await stateStore.read()
      for (const item of latestConfig.items) {
        const result = await processItem(item, latestConfig, state, ctx)
        results.push(result)
      }
      await stateStore.write(pruneState(state, now()))
      const result: MarketDataAlertRunResult = {
        enabled: true,
        skipped: false,
        every: latestConfig.every,
        itemCount: latestConfig.items.length,
        results,
        startedAt,
        finishedAt: new Date(now()).toISOString(),
      }
      await recordRunResult(result)
      return result
    } finally {
      processing = false
    }
  }

  async function recordRunResult(result: MarketDataAlertRunResult): Promise<void> {
    await runStore.append(recordsFromRunResult(result))
  }

  async function processItem(
    item: MarketDataAlertItem,
    config: MarketDataAlertConfig,
    state: AlertState,
    ctx?: ListenerContext<AlertEmits>,
  ): Promise<MarketDataAlertItemResult> {
    const mode = item.mode ?? config.mode
    const base = {
      asset: item.asset,
      symbol: item.symbol,
      interval: effectiveInterval(item),
      provider: item.provider,
      mode,
      notified: false,
      taskRequested: false,
      signals: [],
    }

    if (item.enabled === false) {
      return { ...base, ok: true, skipped: true, reason: 'item_disabled' }
    }

    try {
      const candles = await fetchCandles(item, config)
      if (candles.length === 0) {
        await emitSkipped(ctx, item, 'no_candles')
        return { ...base, ok: true, skipped: true, reason: 'no_candles' }
      }

      const analysis = analyzer.analyze(candles, item.options as TechnicalAnalysisOptions | undefined)
      const signals = collectSignals(analysis, item)
      const fresh = signals.filter((signal) => shouldTriggerSignal(state, item, signal, item.cooldownMinutes ?? config.cooldownMinutes, now()))
      if (fresh.length === 0) {
        await emitSkipped(ctx, item, 'no_new_signals')
        return {
          ...base,
          ok: true,
          skipped: true,
          reason: 'no_new_signals',
          latestClose: analysis.summary.latestClose,
          signals: [],
        }
      }

      const text = renderAlert(item, analysis, fresh)
      let notified = false
      let taskRequested = false
      let workspaceExecution: MarketDataAlertWorkspaceExecution | undefined

      if (mode === 'deterministic' || mode === 'both') {
        await connectorCenter.notify(text, { source: 'task' })
        notified = true
      }

      if (mode === 'agent' || mode === 'both') {
        const prompt = renderAgentPrompt(item, analysis, fresh)
        const workspace = item.workspace ?? config.workspace
        if (deps.runWorkspaceTask) {
          const workspaceResult = await deps.runWorkspaceTask({
            item,
            prompt,
            timeoutMs: workspace?.timeoutMs ?? 120_000,
            agent: workspace?.agent,
            resume: workspace?.resume,
            workspaceId: workspace?.workspaceId,
          })
          workspaceExecution = {
            ok: workspaceResult.ok,
            ...(workspaceResult.skipped == null ? {} : { skipped: workspaceResult.skipped }),
            ...(workspaceResult.error ? { error: workspaceResult.error } : {}),
            ...(workspaceResult.workspaceId ? { workspaceId: workspaceResult.workspaceId } : {}),
            ...(workspaceResult.agent ? { agent: workspaceResult.agent } : {}),
          }
          taskRequested = workspaceResult.ok
        } else if (ctx) {
          await ctx.emit('agent.work.requested', {
            source: 'task',
            prompt,
            metadata: { source: 'task', trigger: 'market_data_alert' },
          })
          taskRequested = true
        } else if (deps.requestTask) {
          await deps.requestTask(prompt)
          taskRequested = true
        }
      }

      for (const signal of fresh) {
        state.seenSignals[stateKey(item, signal)] = now()
      }

      return {
        ...base,
        ok: true,
        latestClose: analysis.summary.latestClose,
        signals: fresh,
        notified,
        taskRequested,
        ...(workspaceExecution ? { workspaceExecution } : {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`market-data-alert: ${item.asset}:${item.symbol}:${effectiveInterval(item)} failed:`, message)
      return { ...base, ok: false, error: message }
    }
  }

  async function fetchCandles(item: MarketDataAlertItem, config: MarketDataAlertConfig): Promise<TechnicalAnalysisCandle[]> {
    const interval = effectiveInterval(item)
    const params: Record<string, unknown> = {
      symbol: item.symbol,
      interval,
      start_date: buildLookbackStart(interval, item.lookbackBars ?? config.lookbackBars),
    }
    if (item.provider) params.provider = item.provider

    const rows = await cacheService.getHistorical(item.asset, params, (p) => {
      switch (item.asset) {
        case 'equity':
          return clients.equity.getHistorical(p) as Promise<Record<string, unknown>[]>
        case 'crypto':
          return clients.crypto.getHistorical(p) as Promise<Record<string, unknown>[]>
        case 'currency':
          return clients.currency.getHistorical(p) as Promise<Record<string, unknown>[]>
        case 'commodity':
          return clients.commodity.getSpotPrices({ ...p, interval: '1d' }) as Promise<Record<string, unknown>[]>
      }
    })

    return normalizeCandles(rows)
  }

  const listener: Listener<'cron.fire', AlertEmits> = {
    name: 'market-data-alert',
    subscribes: 'cron.fire',
    emits: ALERT_EMITS,
    handle: handleFire,
  }

  return {
    listener,
    async start() {
      const latestConfig = await readConfig()
      pump = createPump({
        name: 'market-data-alert',
        every: latestConfig.every,
        enabled: latestConfig.enabled,
        onTick: async () => { await runOnce() },
      })
      pump.start()
    },
    stop() {
      pump?.stop()
      pump = null
      if (registered) {
        registry.unregister(listener.name)
        registered = false
      }
    },
    runOnce,
  }
}

function recordsFromRunResult(result: MarketDataAlertRunResult): Array<Omit<MarketDataAlertRunRecord, 'runId'>> {
  if (result.results.length === 0) {
    return [{
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      status: result.skipped ? 'skipped' : 'error',
      skipped: result.skipped,
      reason: result.reason ?? (result.skipped ? 'no_items' : undefined),
      signals: [],
      notified: false,
      taskRequested: false,
      summary: result.reason ? `Alert run skipped: ${result.reason}` : 'Alert run completed without item results.',
    }]
  }

  return result.results.map((item): Omit<MarketDataAlertRunRecord, 'runId'> => {
    const status = item.ok
      ? item.skipped ? 'skipped' : 'triggered'
      : 'error'
    return {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      asset: item.asset,
      symbol: item.symbol,
      interval: item.interval,
      provider: item.provider,
      mode: item.mode,
      status,
      skipped: item.skipped,
      reason: item.reason,
      latestClose: item.latestClose,
      signals: item.signals,
      notified: item.notified,
      taskRequested: item.taskRequested,
      workspaceExecution: item.workspaceExecution,
      error: item.error,
      summary: summarizeItemResult(item),
    }
  })
}

function summarizeItemResult(item: MarketDataAlertItemResult): string {
  if (!item.ok) return `${item.symbol} ${item.interval} failed: ${item.error ?? 'unknown error'}`
  if (item.skipped) return `${item.symbol} ${item.interval} skipped: ${item.reason ?? 'no signal'}`
  return `${item.symbol} ${item.interval} triggered ${item.signals.length} signal${item.signals.length === 1 ? '' : 's'}: ${item.signals.slice(0, 3).map((signal) => signal.label).join(', ')}`
}

async function emitSkipped(
  ctx: ListenerContext<AlertEmits> | undefined,
  item: MarketDataAlertItem,
  reason: string,
): Promise<void> {
  void ctx
  void item
  void reason
}

function collectSignals(analysis: TechnicalAnalysisAnalysis, item: MarketDataAlertItem): MarketDataAlertSignal[] {
  const maxAgeBars = item.thresholds?.maxSignalAgeBars ?? 3
  const latestIndex = Math.max(0, analysis.summary.candles - 1)
  const minVolumeScore = item.thresholds?.minVolumeScore ?? Number.NEGATIVE_INFINITY
  const signals: MarketDataAlertSignal[] = []

  for (const event of analysis.structureEvents.filter((event) => latestIndex - event.index <= maxAgeBars)) {
    signals.push(signalFromStructure(event))
  }

  for (const zone of analysis.relevance.zones.filter((zone) => latestIndex - zone.index <= maxAgeBars)) {
    signals.push(signalFromZone(zone))
  }

  for (const signal of analysis.volumePriceSignals.filter((signal) =>
    latestIndex - signal.index <= maxAgeBars && signal.score >= minVolumeScore
  )) {
    signals.push(signalFromVolume(signal))
  }

  return dedupeSignals(signals).sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
}

function signalFromStructure(event: StructureEvent): MarketDataAlertSignal {
  return {
    id: `structure:${event.id}`,
    kind: 'structure',
    label: `${event.level} ${event.type}`,
    direction: event.direction,
    index: event.index,
    time: event.time,
    price: event.breakPrice,
    message: `${event.direction} ${event.level} ${event.type} at ${event.breakPrice}`,
    volumeConfirmation: event.volumeConfirmation,
  }
}

function signalFromZone(zone: TechnicalAnalysisRelevantZone): MarketDataAlertSignal {
  const label = zone.kind === 'order_block'
    ? 'relevant OB'
    : zone.kind === 'fair_value_gap'
      ? 'relevant FVG'
      : zone.kind === 'liquidity'
        ? 'relevant liquidity'
        : zone.kind === 'balance_price_range'
          ? 'relevant BPR'
          : 'relevant confluence'
  const kind = zone.kind === 'liquidity'
    ? 'liquidity'
    : zone.kind === 'balance_price_range'
      ? 'bpr'
      : zone.kind === 'confluence'
        ? 'confluence'
        : 'zone'
  return {
    id: `zone:${zone.kind}:${zone.id}`,
    kind,
    label,
    direction: zone.direction,
    index: zone.index,
    time: zone.time,
    price: zone.midpoint,
    message: `${zone.direction} ${label} ${zone.bottom}-${zone.top} (${zone.status})`,
    volumeConfirmation: zone.volumeConfirmation,
  }
}

function signalFromVolume(signal: VolumePriceSignal): MarketDataAlertSignal {
  const kind = signal.kind === 'vp_level'
    ? 'vp_level'
    : signal.kind === 'vwap_deviation'
      ? 'vwap_deviation'
      : signal.kind === 'stop_run'
        ? 'stop_run'
        : signal.kind === 'unusual_volume'
          ? 'unusual_volume'
          : signal.kind === 'ifvg_inversion'
            ? 'ifvg'
            : 'volume'
  return {
    id: `volume:${signal.id}`,
    kind,
    label: signal.kind,
    direction: signal.direction,
    index: signal.index,
    time: signal.time,
    message: signal.message,
    score: signal.score,
    confluenceScore: signal.confluenceScore,
  }
}

function dedupeSignals(signals: MarketDataAlertSignal[]): MarketDataAlertSignal[] {
  const byId = new Map<string, MarketDataAlertSignal>()
  for (const signal of signals) byId.set(signal.id, signal)
  return [...byId.values()]
}

function shouldTriggerSignal(
  state: AlertState,
  item: MarketDataAlertItem,
  signal: MarketDataAlertSignal,
  cooldownMinutes: number,
  nowMs: number,
): boolean {
  const seenAt = state.seenSignals[stateKey(item, signal)]
  if (!seenAt) return true
  return nowMs - seenAt >= cooldownMinutes * 60_000
}

function stateKey(item: MarketDataAlertItem, signal: MarketDataAlertSignal): string {
  return [
    item.asset,
    item.symbol.toUpperCase(),
    effectiveInterval(item),
    item.provider ?? '',
    signal.id,
  ].join('|')
}

function renderAlert(item: MarketDataAlertItem, analysis: TechnicalAnalysisAnalysis, signals: MarketDataAlertSignal[]): string {
  const lines = [
    `Market Alert: ${item.symbol} ${effectiveInterval(item)}`,
    `Close: ${formatNumber(analysis.summary.latestClose)} | trend: ${analysis.summary.trend} (swing ${analysis.summary.swingTrend}, internal ${analysis.summary.internalTrend})`,
    `Signals: ${signals.slice(0, 5).map((signal) => signal.message).join('; ')}`,
  ]
  if (analysis.relevance.nearestSupport) {
    lines.push(`Nearest support: ${formatZone(analysis.relevance.nearestSupport)}`)
  }
  if (analysis.relevance.nearestResistance) {
    lines.push(`Nearest resistance: ${formatZone(analysis.relevance.nearestResistance)}`)
  }
  return lines.join('\n')
}

function renderAgentPrompt(item: MarketDataAlertItem, analysis: TechnicalAnalysisAnalysis, signals: MarketDataAlertSignal[]): string {
  return [
    `Analyze this market-data alert for ${item.symbol} ${effectiveInterval(item)}.`,
    `Asset: ${item.asset}${item.provider ? ` provider: ${item.provider}` : ''}`,
    `Latest close: ${formatNumber(analysis.summary.latestClose)}`,
    `Trend: ${analysis.summary.trend}; swing=${analysis.summary.swingTrend}; internal=${analysis.summary.internalTrend}`,
    `Triggered signals:\n${signals.map((signal) => `- ${signal.label}: ${signal.message}`).join('\n')}`,
    analysis.relevance.nearestSupport ? `Nearest support: ${formatZone(analysis.relevance.nearestSupport)}` : '',
    analysis.relevance.nearestResistance ? `Nearest resistance: ${formatZone(analysis.relevance.nearestResistance)}` : '',
    'Respond concisely with structure, volume confirmation, invalidation area, and what to monitor next. Do not place trades.',
  ].filter(Boolean).join('\n')
}

function normalizeCandles(rows: Array<Record<string, unknown>>): TechnicalAnalysisCandle[] {
  return rows
    .map((row): TechnicalAnalysisCandle | null => {
      const time = typeof row.date === 'string' || typeof row.date === 'number'
        ? row.date
        : typeof row.time === 'string' || typeof row.time === 'number'
          ? row.time
          : ''
      const open = toFiniteNumber(row.open)
      const high = toFiniteNumber(row.high)
      const low = toFiniteNumber(row.low)
      const close = toFiniteNumber(row.close)
      if (!time || open == null || high == null || low == null || close == null) return null
      const volume = toFiniteNumber(row.volume)
      const vwap = toFiniteNumber(row.vwap)
      return {
        time,
        open,
        high,
        low,
        close,
        ...(volume == null ? {} : { volume }),
        ...(vwap == null ? {} : { vwap }),
      }
    })
    .filter((row): row is TechnicalAnalysisCandle => row !== null)
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function effectiveInterval(item: MarketDataAlertItem): string {
  return item.asset === 'commodity' ? '1d' : item.interval
}

function buildLookbackStart(interval: string, bars: number): string {
  const ms = intervalToMs(interval) ?? 86_400_000
  return new Date(Date.now() - ms * bars).toISOString().slice(0, 10)
}

function intervalToMs(interval: string): number | null {
  const match = interval.match(/^(\d+)([mhdw])$/)
  if (!match) return null
  const n = Number(match[1])
  const unit = match[2]
  if (unit === 'm') return n * 60_000
  if (unit === 'h') return n * 3_600_000
  if (unit === 'd') return n * 86_400_000
  if (unit === 'w') return n * 7 * 86_400_000
  return null
}

function formatNumber(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function formatZone(zone: TechnicalAnalysisRelevantZone): string {
  return `${zone.kind} ${zone.direction} ${formatNumber(zone.bottom)}-${formatNumber(zone.top)} (${zone.status}, ${zone.distanceAtr.toFixed(2)} ATR)`
}

function pruneState(state: AlertState, nowMs: number): AlertState {
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000
  for (const [key, ts] of Object.entries(state.seenSignals)) {
    if (nowMs - ts > maxAgeMs) delete state.seenSignals[key]
  }
  return state
}

function createJsonStateStore(path: string): StateStore {
  async function read(): Promise<AlertState> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<AlertState>
      return {
        seenSignals: parsed.seenSignals && typeof parsed.seenSignals === 'object' ? parsed.seenSignals : {},
      }
    } catch (error) {
      if (isENOENT(error)) return { seenSignals: {} }
      throw error
    }
  }

  async function write(state: AlertState): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
    await rename(tmp, path)
  }

  return { read, write }
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
