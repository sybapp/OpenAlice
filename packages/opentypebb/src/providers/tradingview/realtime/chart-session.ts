import { createSessionId } from './session-id.js'
import type { TradingViewRealtimeClient } from './client.js'
import type { TradingViewRealtimeListener } from './types.js'

export type TradingViewTimeframe =
  | '1'
  | '3'
  | '5'
  | '15'
  | '30'
  | '45'
  | '60'
  | '120'
  | '180'
  | '240'
  | '1D'
  | '1W'
  | '1M'
  | string

export type TradingViewChartType =
  | 'HeikinAshi'
  | 'Renko'
  | 'LineBreak'
  | 'Kagi'
  | 'PointAndFigure'
  | 'Range'

export interface TradingViewChartTypeInputs {
  atrLength?: number
  source?: 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4'
  style?: 'ATR' | string
  boxSize?: number
  reversalAmount?: number
  sources?: 'Close'
  wicks?: boolean
  lb?: number
  oneStepBackBuilding?: boolean
  phantomBars?: boolean
  range?: number
  [key: string]: unknown
}

const chartTypes: Record<TradingViewChartType, string> = {
  HeikinAshi: 'BarSetHeikenAshi@tv-basicstudies-60!',
  Renko: 'BarSetRenko@tv-prostudies-40!',
  LineBreak: 'BarSetPriceBreak@tv-prostudies-34!',
  Kagi: 'BarSetKagi@tv-prostudies-34!',
  PointAndFigure: 'BarSetPnF@tv-prostudies-34!',
  Range: 'BarSetRange@tv-basicstudies-72!',
}

export interface TradingViewCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface TradingViewChartMarketOptions {
  timeframe?: TradingViewTimeframe
  range?: number
  to?: number
  adjustment?: 'splits' | 'dividends' | string
  backadjustment?: boolean
  session?: 'regular' | 'extended' | string
  currency?: string
  type?: TradingViewChartType
  inputs?: TradingViewChartTypeInputs
  replay?: number
}

export interface TradingViewMarketInfo {
  seriesId: string
  [key: string]: unknown
}

export interface TradingViewChartUpdate {
  symbol: string
  candles: TradingViewCandle[]
  changes: string[]
  marketInfo: TradingViewMarketInfo | null
}

export interface TradingViewChartSubscription {
  close(): void
}

export interface TradingViewChartError {
  kind: 'symbol_error' | 'series_error' | 'critical_error'
  message: string
  details?: unknown
}

export interface TradingViewReplayEvent {
  type: 'loaded' | 'point' | 'resolution' | 'end'
  value?: unknown
  extra?: unknown
}

export type TradingViewStudyPacketListener = (packet: { type: string; data: unknown[] }) => void

function normalizeCandle(values: unknown[]): TradingViewCandle | null {
  const [time, open, high, low, close, volume] = values
  if (
    typeof time !== 'number' ||
    typeof open !== 'number' ||
    typeof high !== 'number' ||
    typeof low !== 'number' ||
    typeof close !== 'number'
  ) {
    return null
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume: typeof volume === 'number' ? Math.round(volume * 100) / 100 : null,
  }
}

function sortedCandles(candles: Map<number, TradingViewCandle>): TradingViewCandle[] {
  return [...candles.values()].sort((left, right) => left.time - right.time)
}

export class TradingViewChartSession {
  readonly sessionId = createSessionId('cs')
  readonly replaySessionId = createSessionId('rs')

  private readonly candles = new Map<number, TradingViewCandle>()
  private readonly listeners = new Set<TradingViewRealtimeListener<[TradingViewChartUpdate]>>()
  private readonly symbolListeners = new Set<TradingViewRealtimeListener<[TradingViewMarketInfo]>>()
  private readonly errorListeners = new Set<TradingViewRealtimeListener<[TradingViewChartError]>>()
  private readonly replayListeners = new Set<TradingViewRealtimeListener<[TradingViewReplayEvent]>>()
  private readonly replayRequests = new Map<string, () => void>()
  private readonly studyListeners = new Map<string, TradingViewStudyPacketListener>()
  private symbol = ''
  private marketInfo: TradingViewMarketInfo | null = null
  private currentSeries = 0
  private seriesCreated = false
  private replayMode = false

  constructor(private readonly client: TradingViewRealtimeClient) {
    this.client.registerSession(this.sessionId, {
      type: 'chart',
      onPacket: (packet) => this.handlePacket(packet),
    })
    this.client.registerSession(this.replaySessionId, {
      type: 'replay',
      onPacket: (packet) => this.handleReplayPacket(packet),
    })
    this.client.send('chart_create_session', [this.sessionId])
  }

  get currentCandles(): TradingViewCandle[] {
    return sortedCandles(this.candles)
  }

  get currentMarketInfo(): TradingViewMarketInfo | null {
    return this.marketInfo
  }

  onSymbolResolved(listener: TradingViewRealtimeListener<[TradingViewMarketInfo]>): () => void {
    this.symbolListeners.add(listener)
    return () => this.symbolListeners.delete(listener)
  }

  onError(listener: TradingViewRealtimeListener<[TradingViewChartError]>): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onReplay(listener: TradingViewRealtimeListener<[TradingViewReplayEvent]>): () => void {
    this.replayListeners.add(listener)
    return () => this.replayListeners.delete(listener)
  }

  registerStudy(studyId: string, listener: TradingViewStudyPacketListener): void {
    this.studyListeners.set(studyId, listener)
  }

  unregisterStudy(studyId: string): void {
    this.studyListeners.delete(studyId)
  }

  send(command: string, params: unknown[] = []): void {
    this.client.send(command, params)
  }

  subscribe(
    symbol: string,
    listener: TradingViewRealtimeListener<[TradingViewChartUpdate]>,
    options: TradingViewChartMarketOptions = {},
  ): TradingViewChartSubscription {
    this.listeners.add(listener)
    this.setMarket(symbol, options)

    return {
      close: () => {
        this.listeners.delete(listener)
      },
    }
  }

  setMarket(symbol: string, options: TradingViewChartMarketOptions = {}): void {
    this.symbol = symbol
    this.candles.clear()
    this.marketInfo = null

    if (this.replayMode && !options.replay) {
      this.replayMode = false
      this.client.send('replay_delete_session', [this.replaySessionId])
    }

    const symbolInit: Record<string, unknown> = {
      symbol,
      adjustment: options.adjustment ?? 'splits',
    }
    if (options.backadjustment) {
      symbolInit.backadjustment = 'default'
    }
    if (options.session) {
      symbolInit.session = options.session
    }
    if (options.currency) {
      symbolInit['currency-id'] = options.currency
    }

    if (options.replay) {
      this.replayMode = true
      this.client.send('replay_create_session', [this.replaySessionId])
      this.client.send('replay_add_series', [
        this.replaySessionId,
        'req_replay_addseries',
        `=${JSON.stringify(symbolInit)}`,
        options.timeframe,
      ])
      this.client.send('replay_reset', [
        this.replaySessionId,
        'req_replay_reset',
        options.replay,
      ])
    }

    const complex = options.type || options.replay
    const chartInit: Record<string, unknown> = complex ? {} : symbolInit
    if (complex) {
      chartInit.symbol = symbolInit
      if (options.replay) {
        chartInit.replay = this.replaySessionId
      }
      if (options.type) {
        chartInit.type = chartTypes[options.type]
        chartInit.inputs = { ...options.inputs }
      }
    }

    this.currentSeries += 1
    this.seriesCreated = false

    this.client.send('resolve_symbol', [
      this.sessionId,
      `ser_${this.currentSeries}`,
      `=${JSON.stringify(chartInit)}`,
    ])
    this.setSeries(options.timeframe ?? '1D', options.range ?? 100, options.to)
  }

  setSeries(timeframe: TradingViewTimeframe, range = 100, reference?: number): void {
    if (!this.currentSeries) {
      throw new Error('Set a TradingView chart market before setting the series.')
    }

    const calcRange = reference === undefined ? range : ['bar_count', reference, range]
    this.client.send(`${this.seriesCreated ? 'modify' : 'create'}_series`, [
      this.sessionId,
      '$prices',
      's1',
      `ser_${this.currentSeries}`,
      timeframe,
      this.seriesCreated ? '' : calcRange,
    ])
    this.seriesCreated = true
  }

  fetchMore(count = 1): void {
    this.client.send('request_more_data', [this.sessionId, '$prices', count])
  }

  setTimezone(timezone: string): void {
    this.candles.clear()
    this.client.send('switch_timezone', [this.sessionId, timezone])
  }

  replayStep(count = 1): Promise<void> {
    return this.sendReplayRequest('replay_step', count)
  }

  replayStart(interval = 1000): Promise<void> {
    return this.sendReplayRequest('replay_start', interval)
  }

  replayStop(): Promise<void> {
    return this.sendReplayRequest('replay_stop')
  }

  close(): void {
    if (this.replayMode) {
      this.client.send('replay_delete_session', [this.replaySessionId])
    }
    this.client.send('chart_delete_session', [this.sessionId])
    this.client.unregisterSession(this.sessionId)
    this.client.unregisterSession(this.replaySessionId)
    this.listeners.clear()
    this.symbolListeners.clear()
    this.errorListeners.clear()
    this.replayListeners.clear()
    this.replayRequests.clear()
    this.studyListeners.clear()
    this.candles.clear()
    this.marketInfo = null
  }

  private handlePacket(packet: { type: string; data: unknown[] }): void {
    if (packet.type === 'symbol_resolved') {
      const [_, seriesId, info] = packet.data
      this.marketInfo = {
        seriesId: String(seriesId ?? ''),
        ...(info && typeof info === 'object' ? info as Record<string, unknown> : {}),
      }
      for (const listener of this.symbolListeners) {
        listener(this.marketInfo)
      }
      return
    }

    if (packet.type === 'symbol_error') {
      this.emitError({
        kind: 'symbol_error',
        message: String(packet.data[2] ?? 'TradingView symbol error'),
        details: packet.data,
      })
      return
    }

    if (packet.type === 'series_error') {
      this.emitError({
        kind: 'series_error',
        message: String(packet.data[3] ?? 'TradingView series error'),
        details: packet.data,
      })
      return
    }

    if (packet.type === 'critical_error') {
      this.emitError({
        kind: 'critical_error',
        message: String(packet.data[1] ?? 'TradingView critical error'),
        details: packet.data[2],
      })
      return
    }

    const studyId = typeof packet.data[1] === 'string' ? packet.data[1] : null
    if (studyId && this.studyListeners.has(studyId)) {
      this.studyListeners.get(studyId)?.(packet)
      return
    }

    if (packet.type !== 'timescale_update' && packet.type !== 'du') {
      return
    }

    const update = packet.data[1]
    if (!update || typeof update !== 'object') {
      return
    }

    const changes: string[] = []
    const source = update as Record<string, unknown>
    for (const key of Object.keys(source)) {
      changes.push(key)
      if (this.studyListeners.has(key)) {
        this.studyListeners.get(key)?.(packet)
        continue
      }
      if (key !== '$prices') {
        continue
      }

      const prices = source[key] as { s?: Array<{ v?: unknown[] }> } | undefined
      for (const point of prices?.s ?? []) {
        const candle = Array.isArray(point.v) ? normalizeCandle(point.v) : null
        if (candle) {
          this.candles.set(candle.time, candle)
        }
      }
    }

    if (changes.length > 0) {
      const payload = {
        symbol: this.symbol,
        candles: this.currentCandles,
        changes,
        marketInfo: this.marketInfo,
      }
      for (const listener of this.listeners) {
        listener(payload)
      }
    }
  }

  private handleReplayPacket(packet: { type: string; data: unknown[] }): void {
    if (packet.type === 'replay_ok') {
      const requestId = String(packet.data[1] ?? '')
      this.replayRequests.get(requestId)?.()
      this.replayRequests.delete(requestId)
      return
    }
    if (packet.type === 'replay_instance_id') {
      this.emitReplay({ type: 'loaded', value: packet.data[1] })
      return
    }
    if (packet.type === 'replay_point') {
      this.emitReplay({ type: 'point', value: packet.data[1] })
      return
    }
    if (packet.type === 'replay_resolutions') {
      this.emitReplay({ type: 'resolution', value: packet.data[1], extra: packet.data[2] })
      return
    }
    if (packet.type === 'replay_data_end') {
      this.emitReplay({ type: 'end' })
      return
    }
    if (packet.type === 'critical_error') {
      this.emitError({
        kind: 'critical_error',
        message: String(packet.data[1] ?? 'TradingView replay critical error'),
        details: packet.data[2],
      })
    }
  }

  private sendReplayRequest(command: 'replay_step' | 'replay_start' | 'replay_stop', value?: number): Promise<void> {
    if (!this.replayMode) {
      return Promise.reject(new Error('No TradingView replay session is active.'))
    }

    const requestId = createSessionId(`rsq_${command.replace('replay_', '')}`)
    const params = value === undefined
      ? [this.replaySessionId, requestId]
      : [this.replaySessionId, requestId, value]
    this.client.send(command, params)
    return new Promise((resolve) => {
      this.replayRequests.set(requestId, resolve)
    })
  }

  private emitError(error: TradingViewChartError): void {
    for (const listener of this.errorListeners) {
      listener(error)
    }
  }

  private emitReplay(event: TradingViewReplayEvent): void {
    for (const listener of this.replayListeners) {
      listener(event)
    }
  }
}
