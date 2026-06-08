export type TradingViewRealtimeServer = 'data' | 'prodata' | 'widgetdata' | string

export interface TradingViewRealtimeCredentials {
  tradingview_sessionid?: string
  tradingview_sessionid_sign?: string
  authToken?: string
}

export type TradingViewRealtimeEvent =
  | 'connected'
  | 'disconnected'
  | 'authenticated'
  | 'heartbeat'
  | 'packet'
  | 'error'

export interface TradingViewRealtimeSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface TradingViewRealtimeSocketFactoryInput {
  url: string
  headers: Record<string, string>
}

export type TradingViewRealtimeSocketFactory = (
  input: TradingViewRealtimeSocketFactoryInput,
) => TradingViewRealtimeSocket

export interface TradingViewRealtimeClientOptions {
  server?: TradingViewRealtimeServer
  headers?: Record<string, string>
  credentials?: TradingViewRealtimeCredentials | null
  socketFactory?: TradingViewRealtimeSocketFactory
}

export interface TradingViewRealtimeSession {
  type: 'quote' | 'chart' | 'replay' | string
  onPacket(packet: { type: string; data: unknown[] }): void
}

export type TradingViewRealtimeListener<T extends unknown[] = unknown[]> = (...args: T) => void
