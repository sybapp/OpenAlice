import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'

export type TradingViewSearchType = 'stock' | 'crypto' | 'forex'

export interface TradingViewBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface TradingViewBarsRequest {
  symbol: string
  interval: string
  range: number
  to?: number | null
}

export interface TradingViewSearchHit {
  symbol: string
  prefix?: string
  exchange?: string
  description?: string
  [key: string]: unknown
}

export interface TradingViewClient {
  search(query: string, type: TradingViewSearchType): Promise<TradingViewSearchHit[]>
  getBars(request: TradingViewBarsRequest): Promise<TradingViewBar[]>
}

export interface TradingViewSocket {
  send(data: string): void
  close(): void
  onOpen(listener: () => void): void
  onMessage(listener: (data: string) => void): void
  onError(listener: () => void): void
  onClose(listener: () => void): void
}

export interface CreateTradingViewClientOptions {
  fetch?: typeof globalThis.fetch
  createSocket?: () => TradingViewSocket
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

interface TradingViewPacket {
  m?: string
  p?: unknown[]
}

const SEARCH_URL = 'https://symbol-search.tradingview.com/symbol_search/v3'
const WS_URL = 'wss://data.tradingview.com/socket.io/websocket?from=chart&type=chart'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
}
const SearchResponseSchema = z.object({
  symbols: z.array(z.object({
    symbol: z.string(),
    prefix: z.string().optional(),
    exchange: z.string().optional(),
    description: z.string().optional(),
  }).loose()).optional(),
})

class RetryableTradingViewError extends Error {}

function defaultSocket(): TradingViewSocket {
  const socket = new WebSocket(WS_URL, {
    headers: { ...HEADERS, Origin: 'https://www.tradingview.com' },
  })
  const text = (data: RawData) => typeof data === 'string' ? data : data.toString()
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (listener) => { socket.on('open', listener) },
    onMessage: (listener) => { socket.on('message', (data) => listener(text(data))) },
    onError: (listener) => { socket.on('error', listener) },
    onClose: (listener) => { socket.on('close', listener) },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sessionId(): string {
  return `cs_${Math.random().toString(36).slice(2, 14)}`
}

function frame(value: unknown): string {
  const payload = typeof value === 'string' ? value : JSON.stringify(value)
  return `~m~${payload.length}~m~${payload}`
}

function parseFrames(raw: string): Array<TradingViewPacket | number> {
  return raw
    .replace(/~h~/g, '')
    .split(/~m~[0-9]+~m~/g)
    .filter(Boolean)
    .map((part) => JSON.parse(part) as TradingViewPacket | number)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function priceUpdates(packet: TradingViewPacket): TradingViewBar[] {
  if (packet.m !== 'timescale_update' && packet.m !== 'du') return []
  const series = asRecord(packet.p?.[1])
  const prices = asRecord(series?.['$prices'])
  const rows = Array.isArray(prices?.['s']) ? prices['s'] : []
  const bars: TradingViewBar[] = []
  for (const row of rows) {
    const values = asRecord(row)?.['v']
    if (!Array.isArray(values)) continue
    const [time, open, high, low, close, volume] = values
    if (
      typeof time !== 'number' || typeof open !== 'number' ||
      typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number'
    ) continue
    bars.push({
      time,
      open,
      high,
      low,
      close,
      volume: typeof volume === 'number' ? Math.round(volume * 100) / 100 : null,
    })
  }
  return bars
}

function getBarsOnce(
  request: TradingViewBarsRequest,
  createSocket: () => TradingViewSocket,
  timeoutMs: number,
): Promise<TradingViewBar[]> {
  const chartSession = sessionId()
  const resolvedSymbol = 'ser_1'
  const range = Math.max(1, Math.min(Math.floor(request.range), 10_000))
  const bars = new Map<number, TradingViewBar>()

  return new Promise((resolve, reject) => {
    const socket = createSocket()
    let settled = false
    const timeout = setTimeout(() => {
      fail(new RetryableTradingViewError(
        `TradingView request timed out after ${timeoutMs}ms for ${request.symbol}`,
      ))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      try { socket.close() } catch {}
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve([...bars.values()].sort((a, b) => a.time - b.time))
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    socket.onOpen(() => {
      const symbol = `=${JSON.stringify({ symbol: request.symbol, adjustment: 'splits' })}`
      const seriesRange: unknown = request.to
        ? ['bar_count', request.to, range]
        : range
      socket.send(frame({ m: 'set_auth_token', p: ['unauthorized_user_token'] }))
      socket.send(frame({ m: 'chart_create_session', p: [chartSession] }))
      socket.send(frame({ m: 'resolve_symbol', p: [chartSession, resolvedSymbol, symbol] }))
      socket.send(frame({
        m: 'create_series',
        p: [chartSession, '$prices', 's1', resolvedSymbol, request.interval, seriesRange],
      }))
    })

    socket.onMessage((raw) => {
      let packets: Array<TradingViewPacket | number>
      try {
        packets = parseFrames(raw)
      } catch (error) {
        fail(new Error(
          `Failed to parse TradingView websocket packet: ${error instanceof Error ? error.message : String(error)}`,
        ))
        return
      }
      for (const packet of packets) {
        if (typeof packet === 'number') {
          socket.send(frame(`~h~${packet}`))
          continue
        }
        if (packet.m === 'symbol_error') {
          fail(new Error(`TradingView symbol error for ${request.symbol}: ${String(packet.p?.[2] ?? 'unknown')}`))
          return
        }
        if (packet.m === 'series_error') {
          fail(new Error(`TradingView series error for ${request.symbol}: ${String(packet.p?.[3] ?? 'unknown')}`))
          return
        }
        if (packet.m === 'critical_error' || packet.m === 'protocol_error') {
          fail(new Error(`TradingView protocol error for ${request.symbol}: ${JSON.stringify(packet.p ?? [])}`))
          return
        }
        const updates = priceUpdates(packet)
        for (const bar of updates) bars.set(bar.time, bar)
        if (bars.size >= range) {
          succeed()
          return
        }
        if (packet.m === 'series_completed') {
          if (bars.size > 0) succeed()
          else fail(new Error(`TradingView returned no bars for ${request.symbol}`))
          return
        }
      }
    })
    socket.onError(() => fail(new RetryableTradingViewError(
      `TradingView websocket error for ${request.symbol}`,
    )))
    socket.onClose(() => {
      if (settled) return
      fail(new RetryableTradingViewError(
        `TradingView websocket closed before completing bars for ${request.symbol}`,
      ))
    })
  })
}

export function createTradingViewClient(
  options: CreateTradingViewClientOptions = {},
): TradingViewClient {
  const request = options.fetch ?? globalThis.fetch
  const createSocket = options.createSocket ?? defaultSocket
  const timeoutMs = options.timeoutMs ?? 25_000
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2))
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250)

  return {
    async search(query, type) {
      const normalized = query.trim().toUpperCase()
      if (!normalized) return []
      const separator = normalized.indexOf(':')
      const exchange = separator > 0 ? normalized.slice(0, separator) : ''
      const text = separator > 0 ? normalized.slice(separator + 1) : normalized
      const url = new URL(SEARCH_URL)
      url.searchParams.set('text', text)
      url.searchParams.set('search_type', type)
      if (exchange) url.searchParams.set('exchange', exchange)
      const response = await request(url, {
        headers: { Origin: 'https://www.tradingview.com', 'User-Agent': HEADERS['User-Agent'] },
      })
      if (!response.ok) {
        throw new Error(`TradingView symbol search failed with HTTP ${response.status}`)
      }
      return SearchResponseSchema.parse(await response.json()).symbols ?? []
    },

    async getBars(barsRequest) {
      const maxAttempts = maxRetries + 1
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await getBarsOnce(barsRequest, createSocket, timeoutMs)
        } catch (error) {
          if (!(error instanceof RetryableTradingViewError)) throw error
          if (attempt === maxAttempts) {
            throw new Error(
              `${error.message} (attempt ${attempt}/${maxAttempts})`,
              { cause: error },
            )
          }
          if (retryDelayMs > 0) await sleep(retryDelayMs * attempt)
        }
      }
      throw new Error(`TradingView retry loop exited unexpectedly for ${barsRequest.symbol}`)
    },
  }
}
