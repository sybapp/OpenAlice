/**
 * AsyncChannel — push-to-pull bridge for converting callbacks into AsyncIterable.
 *
 * Useful when providers emit synchronous callbacks (tool use, tool result, text)
 * but upper layers want a single AsyncIterable stream of ProviderEvents.
 */

export interface AsyncChannel<T> extends AsyncIterable<T> {
  push(value: T): void
  close(): void
  error(err: Error): void
}

export function createChannel<T>(): AsyncChannel<T> {
  const queue: T[] = []
  let closed = false
  let err: Error | null = null
  let waiter: ((result: IteratorResult<T>) => void) | null = null
  let rejectWaiter: ((reason: Error) => void) | null = null

  const resolveWaiter = (result: IteratorResult<T>) => {
    const current = waiter
    waiter = null
    rejectWaiter = null
    current?.(result)
  }

  const rejectPending = (reason: Error) => {
    const reject = rejectWaiter
    waiter = null
    rejectWaiter = null
    reject?.(reason)
  }

  return {
    push(value) {
      if (closed) return
      if (waiter) {
        resolveWaiter({ value, done: false })
        return
      }
      queue.push(value)
    },

    close() {
      if (closed) return
      closed = true
      if (waiter) {
        resolveWaiter({ value: undefined as T, done: true })
      }
    },

    error(reason) {
      if (closed) return
      closed = true
      err = reason
      rejectPending(reason)
    },

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (err) {
            return Promise.reject(err)
          }
          if (closed) {
            return Promise.resolve({ value: undefined as T, done: true })
          }

          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiter = resolve
            rejectWaiter = reject
          })
        },

        [Symbol.asyncIterator]() {
          return this
        },
      }
    },
  }
}
