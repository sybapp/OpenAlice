import JSZip from 'jszip'
import { TradingViewBuiltInIndicator, TradingViewPineIndicator } from '../scanner/indicator.js'
import {
  applyTradingViewGraphicCommands,
  emptyTradingViewGraphics,
  parseTradingViewGraphics,
  type TradingViewGraphicData,
  type TradingViewGraphicStore,
} from './graphic-parser.js'
import { createSessionId } from './session-id.js'
import type { TradingViewChartSession } from './chart-session.js'
import type { TradingViewRealtimeListener } from './types.js'

export type TradingViewStudyIndicator = TradingViewPineIndicator | TradingViewBuiltInIndicator

export interface TradingViewStudyPlotPoint {
  $time: number
  [plot: string]: unknown
}

export interface TradingViewStrategyTrade {
  entry: { name: string; type: 'long' | 'short'; value: unknown; time: unknown }
  exit: { name: string; value: unknown; time: unknown }
  quantity: unknown
  profit: unknown
  cumulative: unknown
  runup: unknown
  drawdown: unknown
}

export interface TradingViewStrategyReport {
  currency?: string
  settings?: unknown
  performance?: unknown
  trades: TradingViewStrategyTrade[]
  history: Record<string, unknown>
}

export interface TradingViewStudyUpdate {
  changes: string[]
  points: TradingViewStudyPlotPoint[]
  strategyReport: TradingViewStrategyReport
  graphics: TradingViewGraphicData
}

export interface TradingViewStudyError {
  message: string
  details?: unknown
}

function indicatorInputs(indicator: TradingViewStudyIndicator): Record<string, unknown> {
  if (indicator instanceof TradingViewPineIndicator) {
    const inputs: Record<string, unknown> = { text: indicator.script }
    if (indicator.pineId) inputs.pineId = indicator.pineId
    if (indicator.pineVersion) inputs.pineVersion = indicator.pineVersion

    Object.keys(indicator.inputs).forEach((inputId, index) => {
      const input = indicator.inputs[inputId]
      if (!input) return
      inputs[inputId] = {
        v: input.type !== 'color' ? input.value : index,
        f: input.isFake,
        t: input.type,
      }
    })
    return inputs
  }

  return indicator.options
}

function tradeType(raw: unknown): 'long' | 'short' {
  return typeof raw === 'string' && raw.startsWith('s') ? 'short' : 'long'
}

function parseTrades(rawTrades: unknown): TradingViewStrategyTrade[] {
  if (!Array.isArray(rawTrades)) return []
  return [...rawTrades].reverse().map((trade) => {
    const source = trade as {
      e?: { c?: string; tp?: string[]; p?: unknown; tm?: unknown }
      x?: { c?: string; p?: unknown; tm?: unknown }
      q?: unknown
      tp?: unknown
      cp?: unknown
      rn?: unknown
      dd?: unknown
    }
    return {
      entry: {
        name: String(source.e?.c ?? ''),
        type: tradeType(source.e?.tp?.[0]),
        value: source.e?.p,
        time: source.e?.tm,
      },
      exit: {
        name: String(source.x?.c ?? ''),
        value: source.x?.p,
        time: source.x?.tm,
      },
      quantity: source.q,
      profit: source.tp,
      cumulative: source.cp,
      runup: source.rn,
      drawdown: source.dd,
    }
  })
}

function updateReport(target: TradingViewStrategyReport, raw: unknown, changes: string[]): void {
  if (!raw || typeof raw !== 'object') return
  const report = raw as Record<string, unknown>

  if (typeof report['currency'] === 'string') {
    target.currency = report['currency']
    changes.push('report.currency')
  }
  if (report['settings']) {
    target.settings = report['settings']
    changes.push('report.settings')
  }
  if (report['performance']) {
    target.performance = report['performance']
    changes.push('report.perf')
  }
  if (report['trades']) {
    target.trades = parseTrades(report['trades'])
    changes.push('report.trades')
  }
  if (report['equity']) {
    target.history = {
      buyHold: report['buyHold'],
      buyHoldPercent: report['buyHoldPercent'],
      drawDown: report['drawDown'],
      drawDownPercent: report['drawDownPercent'],
      equity: report['equity'],
      equityPercent: report['equityPercent'],
    }
    changes.push('report.history')
  }
}

function sortedPoints(points: Map<number, TradingViewStudyPlotPoint>): TradingViewStudyPlotPoint[] {
  return [...points.values()].sort((left, right) => left.$time - right.$time)
}

async function parseCompressedPayload(raw: unknown): Promise<Record<string, unknown> | null> {
  if (typeof raw !== 'string') return null
  const zip = new JSZip()
  const archive = await zip.loadAsync(raw, { base64: true })
  const file = archive.file('') ?? archive.filter((_, entry) => !entry.dir)[0]
  if (!file) return null
  return JSON.parse(await file.async('text')) as Record<string, unknown>
}

export class TradingViewChartStudy {
  readonly studyId = createSessionId('st')

  private points = new Map<number, TradingViewStudyPlotPoint>()
  private graphicStore: TradingViewGraphicStore = {}
  private graphicIndexes: unknown[] = []
  private graphics: TradingViewGraphicData = emptyTradingViewGraphics()
  private strategyReport: TradingViewStrategyReport = { trades: [], history: {} }
  private readonly readyListeners = new Set<TradingViewRealtimeListener<[]>>()
  private readonly updateListeners = new Set<TradingViewRealtimeListener<[TradingViewStudyUpdate]>>()
  private readonly errorListeners = new Set<TradingViewRealtimeListener<[TradingViewStudyError]>>()

  constructor(
    private readonly chart: TradingViewChartSession,
    private indicator: TradingViewStudyIndicator,
  ) {
    this.chart.registerStudy(this.studyId, (packet) => {
      void this.handlePacket(packet)
    })
    this.chart.send('create_study', [
      this.chart.sessionId,
      this.studyId,
      'st1',
      '$prices',
      this.indicator.type,
      indicatorInputs(this.indicator),
    ])
  }

  get currentPoints(): TradingViewStudyPlotPoint[] {
    return sortedPoints(this.points)
  }

  get currentStrategyReport(): TradingViewStrategyReport {
    return this.strategyReport
  }

  get currentGraphics(): TradingViewGraphicData {
    return this.graphics
  }

  onReady(listener: TradingViewRealtimeListener<[]>): () => void {
    const safeListener: TradingViewRealtimeListener<[]> = () => {
      try {
        listener()
      } catch (error) {
        console.error('TradingView study ready listener error:', error)
      }
    }
    this.readyListeners.add(safeListener)
    return () => this.readyListeners.delete(safeListener)
  }

  onUpdate(listener: TradingViewRealtimeListener<[TradingViewStudyUpdate]>): () => void {
    const safeListener: TradingViewRealtimeListener<[TradingViewStudyUpdate]> = (update) => {
      try {
        listener(update)
      } catch (error) {
        console.error('TradingView study update listener error:', error)
      }
    }
    this.updateListeners.add(safeListener)
    return () => this.updateListeners.delete(safeListener)
  }

  onError(listener: TradingViewRealtimeListener<[TradingViewStudyError]>): () => void {
    const safeListener: TradingViewRealtimeListener<[TradingViewStudyError]> = (error) => {
      try {
        listener(error)
      } catch (listenerError) {
        console.error('TradingView study error listener failed:', listenerError)
      }
    }
    this.errorListeners.add(safeListener)
    return () => this.errorListeners.delete(safeListener)
  }

  setIndicator(indicator: TradingViewStudyIndicator): void {
    this.indicator = indicator
    this.chart.send('modify_study', [
      this.chart.sessionId,
      this.studyId,
      'st1',
      indicatorInputs(this.indicator),
    ])
  }

  remove(): void {
    this.chart.send('remove_study', [this.chart.sessionId, this.studyId])
    this.chart.unregisterStudy(this.studyId)
    this.readyListeners.clear()
    this.updateListeners.clear()
    this.errorListeners.clear()
  }

  private async handlePacket(packet: { type: string; data: unknown[] }): Promise<void> {
    if (packet.type === 'study_completed') {
      for (const listener of this.readyListeners) listener()
      return
    }
    if (packet.type === 'study_error') {
      this.emitError({
        message: String(packet.data[3] ?? 'TradingView study error'),
        details: packet.data[4],
      })
      return
    }
    if (packet.type !== 'timescale_update' && packet.type !== 'du') {
      return
    }

    const update = packet.data[1]
    const studyData = update && typeof update === 'object'
      ? (update as Record<string, unknown>)[this.studyId]
      : null
    if (!studyData || typeof studyData !== 'object') return

    const changes: string[] = []
    const source = studyData as Record<string, unknown>
    const series = source['st'] as Array<{ v?: unknown[] }> | undefined
    for (const point of series ?? []) {
      if (!Array.isArray(point.v) || typeof point.v[0] !== 'number') continue
      const row: TradingViewStudyPlotPoint = { $time: point.v[0] }
      point.v.forEach((value, index) => {
        if (index === 0) return
        const plotId = `plot_${index - 1}`
        const plotName = this.indicator instanceof TradingViewPineIndicator
          ? this.indicator.plots[plotId] ?? plotId
          : plotId
        row[plotName] = value
      })
      this.points.set(row.$time, row)
    }
    if (series?.length) changes.push('plots')

    const namespace = source['ns'] as Record<string, unknown> | undefined
    if (namespace?.['d'] && typeof namespace['d'] === 'string') {
      await this.parseNamespace(namespace['d'], changes)
    }
    if (Array.isArray(namespace?.['indexes'])) {
      this.graphicIndexes = namespace['indexes']
      this.graphics = parseTradingViewGraphics(this.graphicStore, this.graphicIndexes)
    }

    if (changes.length > 0) {
      const payload = {
        changes,
        points: this.currentPoints,
        strategyReport: this.strategyReport,
        graphics: this.graphics,
      }
      for (const listener of this.updateListeners) listener(payload)
    }
  }

  private async parseNamespace(raw: string, changes: string[]): Promise<void> {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    if (parsed['graphicsCmds']) {
      this.graphicStore = applyTradingViewGraphicCommands(
        this.graphicStore,
        parsed['graphicsCmds'] as Record<string, unknown>,
      )
      this.graphics = parseTradingViewGraphics(this.graphicStore, this.graphicIndexes)
      changes.push('graphic')
    }
    if (parsed['dataCompressed']) {
      try {
        const data = await parseCompressedPayload(parsed['dataCompressed'])
        updateReport(this.strategyReport, data?.['report'], changes)
      } catch (error) {
        this.emitError({
          message: 'Unable to parse TradingView compressed study data',
          details: error instanceof Error ? error.message : error,
        })
      }
    }
    const data = parsed['data'] as { report?: unknown } | undefined
    if (data?.report) {
      updateReport(this.strategyReport, data.report, changes)
    }
  }

  private emitError(error: TradingViewStudyError): void {
    for (const listener of this.errorListeners) listener(error)
  }
}
