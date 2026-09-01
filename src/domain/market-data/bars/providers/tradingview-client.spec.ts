import { describe, expect, it, vi } from 'vitest'
import {
  createTradingViewClient,
  type TradingViewSocket,
} from './tradingview-client.js'

class FakeSocket implements TradingViewSocket {
  readonly sent: string[] = []
  closed = false
  private openListener?: () => void
  private messageListener?: (data: string) => void
  private errorListener?: () => void
  private closeListener?: () => void

  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
  onOpen(listener: () => void): void { this.openListener = listener }
  onMessage(listener: (data: string) => void): void { this.messageListener = listener }
  onError(listener: () => void): void { this.errorListener = listener }
  onClose(listener: () => void): void { this.closeListener = listener }

  open(): void { this.openListener?.() }
  message(data: string): void { this.messageListener?.(data) }
  error(): void { this.errorListener?.() }
  remoteClose(): void { this.closeListener?.() }
}

function frame(value: unknown): string {
  const payload = JSON.stringify(value)
  return `~m~${payload.length}~m~${payload}`
}

describe('TradingView client', () => {
  it('searches the anonymous symbol endpoint with exchange-qualified queries', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      symbols: [{ symbol: 'AAPL', prefix: 'NASDAQ' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createTradingViewClient({ fetch })

    await expect(client.search('nasdaq:aapl', 'stock')).resolves.toEqual([
      { symbol: 'AAPL', prefix: 'NASDAQ' },
    ])
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(url.origin + url.pathname).toBe('https://symbol-search.tradingview.com/symbol_search/v3')
    expect(url.searchParams.get('text')).toBe('AAPL')
    expect(url.searchParams.get('exchange')).toBe('NASDAQ')
    expect(url.searchParams.get('search_type')).toBe('stock')
  })

  it('speaks the chart protocol and returns normalized price updates', async () => {
    const socket = new FakeSocket()
    const client = createTradingViewClient({ createSocket: () => socket, timeoutMs: 1_000, maxRetries: 0 })
    const pending = client.getBars({ symbol: 'NASDAQ:AAPL', interval: '60', range: 2, to: null })

    socket.open()
    expect(socket.sent.some((packet) => packet.includes('chart_create_session'))).toBe(true)
    expect(socket.sent.some((packet) => packet.includes('NASDAQ:AAPL'))).toBe(true)
    expect(socket.sent.some((packet) => packet.includes('create_series'))).toBe(true)

    socket.message(frame({
      m: 'timescale_update',
      p: ['session', { $prices: { s: [
        { i: 1, v: [1_717_200_000, 190, 195, 189, 194, 123.456] },
        { i: 2, v: [1_717_203_600, 194, 196, 193, 195, null] },
      ] } }],
    }))

    await expect(pending).resolves.toEqual([
      { time: 1_717_200_000, open: 190, high: 195, low: 189, close: 194, volume: 123.46 },
      { time: 1_717_203_600, open: 194, high: 196, low: 193, close: 195, volume: null },
    ])
    expect(socket.closed).toBe(true)
  })

  it('retries transport failures but surfaces provider protocol errors immediately', async () => {
    const first = new FakeSocket()
    const second = new FakeSocket()
    const createSocket = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const client = createTradingViewClient({ createSocket, timeoutMs: 1_000, maxRetries: 1, retryDelayMs: 0 })
    const pending = client.getBars({ symbol: 'NASDAQ:AAPL', interval: 'D', range: 1 })

    first.error()
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2))
    second.open()
    second.message(frame({ m: 'symbol_error', p: ['session', 'symbol', 'not found'] }))

    await expect(pending).rejects.toThrow('TradingView symbol error for NASDAQ:AAPL: not found')
    expect(createSocket).toHaveBeenCalledTimes(2)
  })

  it('retries a partial close without mixing bars between attempts', async () => {
    const first = new FakeSocket()
    const second = new FakeSocket()
    const createSocket = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const client = createTradingViewClient({ createSocket, timeoutMs: 1_000, maxRetries: 1, retryDelayMs: 0 })
    const pending = client.getBars({ symbol: 'NASDAQ:AAPL', interval: 'D', range: 2 })

    first.open()
    first.message(frame({
      m: 'timescale_update',
      p: ['session', { $prices: { s: [
        { i: 1, v: [1_717_200_000, 190, 195, 189, 194, 100] },
      ] } }],
    }))
    first.remoteClose()

    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2))
    second.open()
    second.message(frame({
      m: 'timescale_update',
      p: ['session', { $prices: { s: [
        { i: 2, v: [1_717_203_600, 194, 196, 193, 195, 200] },
      ] } }],
    }))
    second.message(frame({ m: 'series_completed', p: ['session', 's1'] }))

    await expect(pending).resolves.toEqual([
      { time: 1_717_203_600, open: 194, high: 196, low: 193, close: 195, volume: 200 },
    ])
  })

  it('accepts a short result when the provider explicitly completes the series', async () => {
    const socket = new FakeSocket()
    const client = createTradingViewClient({ createSocket: () => socket, timeoutMs: 1_000, maxRetries: 0 })
    const pending = client.getBars({ symbol: 'NASDAQ:AAPL', interval: 'D', range: 3 })

    socket.open()
    socket.message(frame({
      m: 'timescale_update',
      p: ['session', { $prices: { s: [
        { i: 1, v: [1_717_200_000, 190, 195, 189, 194, 100] },
      ] } }],
    }))
    socket.message(frame({ m: 'series_completed', p: ['session', 's1'] }))

    await expect(pending).resolves.toHaveLength(1)
  })

  it('does not treat incomplete silence as a successful response', async () => {
    const socket = new FakeSocket()
    const client = createTradingViewClient({ createSocket: () => socket, timeoutMs: 1_600, maxRetries: 0 })
    const pending = client.getBars({ symbol: 'NASDAQ:AAPL', interval: 'D', range: 2 })

    socket.open()
    socket.message(frame({
      m: 'timescale_update',
      p: ['session', { $prices: { s: [
        { i: 1, v: [1_717_200_000, 190, 195, 189, 194, 100] },
      ] } }],
    }))
    await expect(pending).rejects.toThrow('timed out')
  })
})
