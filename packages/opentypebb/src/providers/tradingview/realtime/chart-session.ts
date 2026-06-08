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
  session?: 'regular' | 'extended' | string
  currency?: string
}

export interface TradingViewChartUpdate {
  symbol: string
  candles: TradingViewCandle[]
  changes: string[]
}

export interface TradingViewChartSubscription {
  close(): void
}

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

  private readonly candles = new Map<number, TradingViewCandle>()
  private readonly listeners = new Set<TradingViewRealtimeListener<[TradingViewChartUpdate]>>()
  private symbol = ''
  private currentSeries = 0
  private seriesCreated = false

  constructor(private readonly client: TradingViewRealtimeClient) {
    this.client.registerSession(this.sessionId, {
      type: 'chart',
      onPacket: (packet) => this.handlePacket(packet),
    })
    this.client.send('chart_create_session', [this.sessionId])
  }

  get currentCandles(): TradingViewCandle[] {
    return sortedCandles(this.candles)
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

    const symbolInit: Record<string, unknown> = {
      symbol,
      adjustment: options.adjustment ?? 'splits',
    }
    if (options.session) {
      symbolInit.session = options.session
    }
    if (options.currency) {
      symbolInit['currency-id'] = options.currency
    }

    this.currentSeries += 1
    this.seriesCreated = false

    this.client.send('resolve_symbol', [
      this.sessionId,
      `ser_${this.currentSeries}`,
      `=${JSON.stringify(symbolInit)}`,
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

  close(): void {
    this.client.send('chart_delete_session', [this.sessionId])
    this.client.unregisterSession(this.sessionId)
    this.listeners.clear()
    this.candles.clear()
  }

  private handlePacket(packet: { type: string; data: unknown[] }): void {
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
      }
      for (const listener of this.listeners) {
        listener(payload)
      }
    }
  }
}
