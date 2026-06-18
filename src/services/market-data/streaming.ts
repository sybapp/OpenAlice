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

    // EventEmitter THROWS (crashing the process) if 'error' is emitted with no
    // registered listener. Only emit when someone is listening; otherwise drop
    // it. StreamManager attaches its own 'error' listener, so manager-owned
    // streams always have one.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    }
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
    // Auto-prune so completed / cancelled / errored streams don't accumulate
    // in the map. dispose() is idempotent, so the explicit delete()/clear()
    // paths below stay correct even though cancel() also fires this listener.
    const prune = () => this.dispose(id, stream)
    stream.once('complete', prune)
    stream.once('cancel', prune)
    stream.once('error', prune)
    return stream
  }

  get<T = any>(id: string): DataStream<T> | undefined {
    return this.streams.get(id) as DataStream<T> | undefined
  }

  delete(id: string): boolean {
    const stream = this.streams.get(id)
    if (!stream) {
      return false
    }
    stream.cancel()           // fires 'cancel' → prune() disposes
    this.dispose(id, stream)  // idempotent safety net
    return true
  }

  list(): string[] {
    return Array.from(this.streams.keys())
  }

  clear(): void {
    for (const id of [...this.streams.keys()]) {
      this.delete(id)
    }
  }

  private dispose(id: string, stream: DataStream): void {
    if (this.streams.get(id) === stream) {
      this.streams.delete(id)
    }
    stream.removeAllListeners()
  }
}

export const globalStreamManager = new StreamManager()
