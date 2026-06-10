import { EventEmitter } from 'events'
import type { MarketDataEnvelope } from './types.js'
import type { MarketDataError } from './errors.js'

export type StreamEventType = 'data' | 'error' | 'complete' | 'cancel'

export interface StreamEvent<T = any> {
  type: StreamEventType
  data?: T
  error?: MarketDataError
  timestamp: Date
}

export interface StreamOptions {
  bufferSize?: number
  autoStart?: boolean
}

export class DataStream<T = any> extends EventEmitter {
  private buffer: T[] = []
  private completed = false
  private cancelled = false
  private readonly bufferSize: number

  constructor(options: StreamOptions = {}) {
    super()
    this.bufferSize = options.bufferSize ?? 100
  }

  push(data: T): void {
    if (this.completed || this.cancelled) {
      return
    }

    this.buffer.push(data)
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift()
    }

    this.emit('data', data)
  }

  error(error: MarketDataError): void {
    if (this.completed || this.cancelled) {
      return
    }

    this.emit('error', error)
  }

  complete(): void {
    if (this.completed || this.cancelled) {
      return
    }

    this.completed = true
    this.emit('complete')
  }

  cancel(): void {
    if (this.cancelled) {
      return
    }

    this.cancelled = true
    this.emit('cancel')
  }

  getBuffer(): T[] {
    return [...this.buffer]
  }

  isCompleted(): boolean {
    return this.completed
  }

  isCancelled(): boolean {
    return this.cancelled
  }

  clearBuffer(): void {
    this.buffer = []
  }
}

export class StreamManager {
  private streams = new Map<string, DataStream>()

  create<T = any>(id: string, options?: StreamOptions): DataStream<T> {
    if (this.streams.has(id)) {
      throw new Error(`Stream '${id}' already exists`)
    }

    const stream = new DataStream<T>(options)
    this.streams.set(id, stream)
    return stream
  }

  get<T = any>(id: string): DataStream<T> | undefined {
    return this.streams.get(id) as DataStream<T> | undefined
  }

  delete(id: string): boolean {
    const stream = this.streams.get(id)
    if (stream) {
      stream.cancel()
      stream.removeAllListeners()
      return this.streams.delete(id)
    }
    return false
  }

  list(): string[] {
    return Array.from(this.streams.keys())
  }

  clear(): void {
    for (const stream of this.streams.values()) {
      stream.cancel()
      stream.removeAllListeners()
    }
    this.streams.clear()
  }
}

export const globalStreamManager = new StreamManager()
