import { describe, expect, it } from 'vitest'

import {
  TradingViewQuoteSession,
  TradingViewRealtimeClient,
  formatHeartbeat,
  formatRealtimeCommand,
  formatRealtimeFrame,
  parseRealtimeFrames,
} from '../index.js'
import type { TradingViewRealtimeSocket } from '../index.js'

class FakeSocket implements TradingViewRealtimeSocket {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (() => void) | ((event: unknown) => void) | ((event: { data: unknown }) => void),
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<(event?: unknown) => void>()
    listeners.add(listener as (event?: unknown) => void)
    this.listeners.set(type, listeners)
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  message(data: string): void {
    this.emit('message', { data })
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function createClient() {
  const socket = new FakeSocket()
  const client = new TradingViewRealtimeClient({
    socketFactory: () => socket,
  })
  socket.open()
  return { client, socket }
}

describe('TradingView realtime protocol', () => {
  it('formats and parses websocket frames and heartbeats', () => {
    const command = formatRealtimeCommand('quote_create_session', ['qs_abc'])
    const heartbeat = formatHeartbeat(42)

    expect(command).toBe('~m~43~m~{"m":"quote_create_session","p":["qs_abc"]}')
    expect(parseRealtimeFrames(`${command}${heartbeat}`)).toEqual([
      { m: 'quote_create_session', p: ['qs_abc'] },
      42,
    ])
  })

  it('ignores malformed fragments instead of throwing', () => {
    expect(parseRealtimeFrames(`${formatRealtimeFrame('{bad json')}${formatRealtimeCommand('ok')}`))
      .toEqual([{ m: 'ok', p: [] }])
  })
})

describe('TradingView realtime client', () => {
  it('queues commands until the socket opens and answers heartbeats', () => {
    const socket = new FakeSocket()
    const client = new TradingViewRealtimeClient({ socketFactory: () => socket })
    const heartbeats: number[] = []
    client.on('heartbeat', (value) => heartbeats.push(Number(value)))

    client.send('quote_create_session', ['qs_abc'])
    expect(socket.sent).toEqual([])

    socket.open()
    expect(socket.sent).toEqual([
      formatRealtimeCommand('set_auth_token', ['unauthorized_user_token']),
      formatRealtimeCommand('quote_create_session', ['qs_abc']),
    ])

    socket.message(formatHeartbeat(7))
    expect(socket.sent.at(-1)).toBe(formatHeartbeat(7))
    expect(heartbeats).toEqual([7])
  })

  it('dispatches packets by session id before emitting generic packets', () => {
    const { client, socket } = createClient()
    const sessionPackets: unknown[] = []
    const genericPackets: unknown[] = []

    client.registerSession('qs_abc', {
      type: 'quote',
      onPacket: (packet) => sessionPackets.push(packet),
    })
    client.on('packet', (packet) => genericPackets.push(packet))

    socket.message(formatRealtimeCommand('qsd', ['qs_abc', { s: 'ok' }]))
    socket.message(formatRealtimeCommand('session_id', ['server-session']))

    expect(sessionPackets).toEqual([{ type: 'qsd', data: ['qs_abc', { s: 'ok' }] }])
    expect(genericPackets).toEqual([{ m: 'session_id', p: ['server-session'] }])
  })
})

describe('TradingView quote session', () => {
  it('subscribes once per symbol, merges updates, and removes the symbol after the last listener closes', () => {
    const { client, socket } = createClient()
    const session = new TradingViewQuoteSession(client, { fields: 'summary' })
    const updates: unknown[] = []

    const subscriptionA = session.subscribe('NASDAQ:AAPL', (data) => updates.push(data))
    const subscriptionB = session.subscribe('NASDAQ:AAPL', (data) => updates.push({ second: data }))
    const key = '= {"session":"regular","symbol":"NASDAQ:AAPL"}'.replace(' ', '')

    const addSymbolCommands = socket.sent.filter((packet) => packet.includes('quote_add_symbols'))
    expect(addSymbolCommands).toHaveLength(1)

    socket.message(formatRealtimeCommand('qsd', [
      session.sessionId,
      { n: key, s: 'ok', v: { lp: 190, volume: 10 } },
    ]))
    socket.message(formatRealtimeCommand('qsd', [
      session.sessionId,
      { n: key, s: 'ok', v: { lp: 191 } },
    ]))

    expect(updates).toEqual([
      { symbol: key, values: { lp: 190, volume: 10 } },
      { second: { symbol: key, values: { lp: 190, volume: 10 } } },
      { symbol: key, values: { lp: 191, volume: 10 } },
      { second: { symbol: key, values: { lp: 191, volume: 10 } } },
    ])

    subscriptionA.close()
    expect(socket.sent.some((packet) => packet.includes('quote_remove_symbols'))).toBe(false)
    subscriptionB.close()
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('quote_remove_symbols', [session.sessionId, key]))
  })
})
