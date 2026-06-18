import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DataStream, StreamManager } from '../streaming.js'
import { MarketDataError, MarketDataErrorCode } from '../errors.js'

describe('DataStream', () => {
  let stream: DataStream<number>

  beforeEach(() => {
    stream = new DataStream()
  })

  describe('push', () => {
    it('emits data event and adds to buffer', () => {
      const listener = vi.fn()
      stream.on('data', listener)

      stream.push(42)

      expect(listener).toHaveBeenCalledWith(42)
      expect(stream.getBuffer()).toEqual([42])
    })

    it('respects buffer size limit', () => {
      stream = new DataStream({ bufferSize: 3 })

      stream.push(1)
      stream.push(2)
      stream.push(3)
      stream.push(4)

      expect(stream.getBuffer()).toEqual([2, 3, 4])
    })

    it('ignores push after completion', () => {
      stream.complete()
      const listener = vi.fn()
      stream.on('data', listener)

      stream.push(42)

      expect(listener).not.toHaveBeenCalled()
      expect(stream.getBuffer()).toEqual([])
    })

    it('ignores push after cancellation', () => {
      stream.cancel()
      const listener = vi.fn()
      stream.on('data', listener)

      stream.push(42)

      expect(listener).not.toHaveBeenCalled()
      expect(stream.getBuffer()).toEqual([])
    })
  })

  describe('error', () => {
    it('emits error event', () => {
      const listener = vi.fn()
      stream.on('error', listener)

      const error = new MarketDataError(
        MarketDataErrorCode.PROVIDER_TIMEOUT,
        'Timeout',
        'test'
      )
      stream.error(error)

      expect(listener).toHaveBeenCalledWith(error)
    })

    it('ignores error after completion', () => {
      stream.complete()
      const listener = vi.fn()
      stream.on('error', listener)

      const error = new MarketDataError(
        MarketDataErrorCode.PROVIDER_TIMEOUT,
        'Timeout',
        'test'
      )
      stream.error(error)

      expect(listener).not.toHaveBeenCalled()
    })

    it('does not throw when no error listener is attached', () => {
      const error = new MarketDataError(MarketDataErrorCode.NETWORK_ERROR, 'boom', 'test')
      // A bare emit('error') with no listener crashes the process; the guard
      // must drop it instead.
      expect(() => stream.error(error)).not.toThrow()
    })
  })

  describe('complete', () => {
    it('emits complete event and sets completed flag', () => {
      const listener = vi.fn()
      stream.on('complete', listener)

      stream.complete()

      expect(listener).toHaveBeenCalled()
      expect(stream.isCompleted()).toBe(true)
    })

    it('ignores multiple complete calls', () => {
      const listener = vi.fn()
      stream.on('complete', listener)

      stream.complete()
      stream.complete()

      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel', () => {
    it('emits cancel event and sets cancelled flag', () => {
      const listener = vi.fn()
      stream.on('cancel', listener)

      stream.cancel()

      expect(listener).toHaveBeenCalled()
      expect(stream.isCancelled()).toBe(true)
    })

    it('ignores multiple cancel calls', () => {
      const listener = vi.fn()
      stream.on('cancel', listener)

      stream.cancel()
      stream.cancel()

      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe('getBuffer', () => {
    it('returns copy of buffer', () => {
      stream.push(1)
      stream.push(2)

      const buffer = stream.getBuffer()
      buffer.push(3)

      expect(stream.getBuffer()).toEqual([1, 2])
    })
  })

  describe('clearBuffer', () => {
    it('clears all buffered data', () => {
      stream.push(1)
      stream.push(2)
      stream.push(3)

      stream.clearBuffer()

      expect(stream.getBuffer()).toEqual([])
    })
  })
})

describe('StreamManager', () => {
  let manager: StreamManager

  beforeEach(() => {
    manager = new StreamManager()
  })

  describe('create', () => {
    it('creates a new stream', () => {
      const stream = manager.create('test-stream')

      expect(stream).toBeInstanceOf(DataStream)
      expect(manager.get('test-stream')).toBe(stream)
    })

    it('throws when creating duplicate stream', () => {
      manager.create('test-stream')

      expect(() => manager.create('test-stream')).toThrow(
        "Stream 'test-stream' already exists"
      )
    })

    it('passes options to stream', () => {
      const stream = manager.create('test-stream', { bufferSize: 5 })

      for (let i = 1; i <= 10; i++) {
        stream.push(i)
      }

      expect(stream.getBuffer()).toHaveLength(5)
    })
  })

  describe('get', () => {
    it('returns existing stream', () => {
      const stream = manager.create('test-stream')
      expect(manager.get('test-stream')).toBe(stream)
    })

    it('returns undefined for nonexistent stream', () => {
      expect(manager.get('nonexistent')).toBeUndefined()
    })
  })

  describe('delete', () => {
    it('deletes stream and cancels it', () => {
      const stream = manager.create('test-stream')
      const cancelListener = vi.fn()
      stream.on('cancel', cancelListener)

      const deleted = manager.delete('test-stream')

      expect(deleted).toBe(true)
      expect(cancelListener).toHaveBeenCalled()
      expect(manager.get('test-stream')).toBeUndefined()
    })

    it('returns false when stream does not exist', () => {
      expect(manager.delete('nonexistent')).toBe(false)
    })
  })

  describe('list', () => {
    it('returns all stream IDs', () => {
      manager.create('stream-1')
      manager.create('stream-2')
      manager.create('stream-3')

      const list = manager.list()
      expect(list).toEqual(['stream-1', 'stream-2', 'stream-3'])
    })

    it('returns empty array when no streams', () => {
      expect(manager.list()).toEqual([])
    })
  })

  describe('clear', () => {
    it('deletes all streams and cancels them', () => {
      const stream1 = manager.create('stream-1')
      const stream2 = manager.create('stream-2')
      const cancel1 = vi.fn()
      const cancel2 = vi.fn()
      stream1.on('cancel', cancel1)
      stream2.on('cancel', cancel2)

      manager.clear()

      expect(cancel1).toHaveBeenCalled()
      expect(cancel2).toHaveBeenCalled()
      expect(manager.list()).toEqual([])
    })
  })

  describe('auto-prune on terminal events', () => {
    it('removes a stream from the map when it completes', () => {
      const stream = manager.create('s')
      stream.complete()
      expect(manager.get('s')).toBeUndefined()
      expect(manager.list()).toEqual([])
    })

    it('removes a stream from the map when it is cancelled', () => {
      manager.create('s')
      manager.get<number>('s')!.cancel()
      expect(manager.get('s')).toBeUndefined()
    })

    it('removes a stream from the map when it errors, without crashing', () => {
      const stream = manager.create('s')
      const error = new MarketDataError(MarketDataErrorCode.NETWORK_ERROR, 'boom', 'test')
      expect(() => stream.error(error)).not.toThrow()
      expect(manager.get('s')).toBeUndefined()
    })
  })
})
