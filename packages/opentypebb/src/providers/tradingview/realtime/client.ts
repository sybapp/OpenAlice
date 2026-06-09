import WebSocket from 'ws'
import {
  formatHeartbeat,
  formatRealtimeCommand,
  parseRealtimeFrames,
  type TradingViewRealtimePacket,
} from './protocol.js'
import type {
  TradingViewRealtimeClientOptions,
  TradingViewRealtimeEvent,
  TradingViewRealtimeListener,
  TradingViewRealtimeSession,
  TradingViewRealtimeSocket,
} from './types.js'

type NodeWebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => TradingViewRealtimeSocket

const defaultHeaders: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
}

export function createDefaultTradingViewSocket(input: { url: string; headers: Record<string, string> }): TradingViewRealtimeSocket {
  const SocketCtor = WebSocket as unknown as NodeWebSocketCtor
  return new SocketCtor(input.url, {
    headers: {
      Origin: 'https://www.tradingview.com',
      ...input.headers,
    },
  })
}

function packetSession(packet: TradingViewRealtimePacket): string | null {
  const [session] = packet.p ?? []
  return typeof session === 'string' ? session : null
}

function packetErrorMessage(event: unknown): string {
  if (event instanceof Error) {
    return event.message
  }
  if (event && typeof event === 'object' && 'message' in event) {
    return String((event as { message: unknown }).message)
  }
  return String(event)
}

export class TradingViewRealtimeClient {
  readonly sessions = new Map<string, TradingViewRealtimeSession>()

  private readonly callbacks = new Map<TradingViewRealtimeEvent, Set<TradingViewRealtimeListener>>()
  private readonly socket: TradingViewRealtimeSocket
  private readonly sendQueue: string[] = []
  private authenticated = false

  constructor(options: TradingViewRealtimeClientOptions = {}) {
    const server = options.server ?? 'data'
    const url = `wss://${server}.tradingview.com/socket.io/websocket?from=chart&type=chart`
    const headers = { ...defaultHeaders, ...options.headers }

    this.socket = (options.socketFactory ?? createDefaultTradingViewSocket)({ url, headers })
    this.bindSocket()

    const authToken = options.credentials?.authToken ?? 'unauthorized_user_token'
    this.enqueue('set_auth_token', [authToken], true)
  }

  get isOpen(): boolean {
    return this.socket.readyState === 1
  }

  on(event: TradingViewRealtimeEvent, listener: TradingViewRealtimeListener): () => void {
    const listeners = this.callbacks.get(event) ?? new Set<TradingViewRealtimeListener>()
    listeners.add(listener)
    this.callbacks.set(event, listeners)
    return () => listeners.delete(listener)
  }

  send(command: string, params: unknown[] = []): void {
    this.enqueue(command, params)
  }

  registerSession(sessionId: string, session: TradingViewRealtimeSession): void {
    this.sessions.set(sessionId, session)
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  close(): void {
    this.socket.close()
  }

  private bindSocket(): void {
    this.socket.addEventListener('open', () => {
      this.emit('connected')
      this.flushQueue()
    })
    this.socket.addEventListener('close', () => {
      this.authenticated = false
      this.emit('disconnected')
    })
    this.socket.addEventListener('error', (event) => {
      this.emit('error', packetErrorMessage(event))
    })
    this.socket.addEventListener('message', (event) => {
      this.handleRawMessage(event.data)
    })
  }

  private enqueue(command: string, params: unknown[], forceAuth = false): void {
    this.sendQueue.push(formatRealtimeCommand(command, params))
    if (forceAuth) {
      this.authenticated = true
      this.emit('authenticated')
    }
    this.flushQueue()
  }

  private flushQueue(): void {
    while (this.isOpen && this.authenticated && this.sendQueue.length > 0) {
      const packet = this.sendQueue.shift()
      if (packet) {
        this.socket.send(packet)
      }
    }
  }

  private handleRawMessage(raw: unknown): void {
    const data = typeof raw === 'string' || raw instanceof ArrayBuffer || raw instanceof Uint8Array
      ? raw
      : String(raw)

    for (const frame of parseRealtimeFrames(data)) {
      if (typeof frame === 'number') {
        this.socket.send(formatHeartbeat(frame))
        this.emit('heartbeat', frame)
        continue
      }

      if (frame.m === 'protocol_error') {
        this.emit('error', frame.p ?? [])
        this.close()
        continue
      }

      if (frame.m && frame.p) {
        const sessionId = packetSession(frame)
        const session = sessionId ? this.sessions.get(sessionId) : null
        if (session) {
          session.onPacket({ type: frame.m, data: frame.p })
          continue
        }
      }

      this.emit('packet', frame)
    }
  }

  private emit(event: TradingViewRealtimeEvent, ...args: unknown[]): void {
    for (const listener of this.callbacks.get(event) ?? []) {
      listener(...args)
    }
  }
}
