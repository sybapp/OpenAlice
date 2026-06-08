export interface TradingViewRealtimePacket {
  m?: string
  p?: unknown[]
}

export type TradingViewRealtimeFrame = TradingViewRealtimePacket | number

const heartbeatMarker = '~h~'
const framePattern = /~m~(\d+)~m~/g

export function parseRealtimeFrames(raw: string | ArrayBuffer | Uint8Array): TradingViewRealtimeFrame[] {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  const frames: TradingViewRealtimeFrame[] = []
  let match: RegExpExecArray | null

  framePattern.lastIndex = 0
  while ((match = framePattern.exec(text)) !== null) {
    const length = Number(match[1])
    const start = framePattern.lastIndex
    const payload = text.slice(start, start + length)
    framePattern.lastIndex = start + length

    if (!payload) {
      continue
    }
    if (payload.startsWith(heartbeatMarker)) {
      const heartbeat = Number(payload.slice(heartbeatMarker.length))
      if (Number.isFinite(heartbeat)) {
        frames.push(heartbeat)
      }
      continue
    }

    try {
      frames.push(JSON.parse(payload) as TradingViewRealtimePacket)
    } catch {
      // TradingView occasionally emits non-JSON diagnostics. The caller only
      // receives parsed protocol frames so malformed fragments stay contained.
    }
  }

  return frames
}

export function formatRealtimeFrame(packet: TradingViewRealtimePacket | string): string {
  const payload = typeof packet === 'string' ? packet : JSON.stringify(packet)
  return `~m~${payload.length}~m~${payload}`
}

export function formatRealtimeCommand(command: string, params: unknown[] = []): string {
  return formatRealtimeFrame({ m: command, p: params })
}

export function formatHeartbeat(heartbeat: number): string {
  return formatRealtimeFrame(`${heartbeatMarker}${heartbeat}`)
}
