import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRetry } from '../retry.js'
import { MarketDataError, MarketDataErrorCode } from '../errors.js'

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success')
    const promise = withRetry(fn)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(MarketDataError.providerTimeout('test', 5000))
      .mockResolvedValue('success')

    const promise = withRetry(fn, { initialDelayMs: 100 })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws immediately on non-retryable error', async () => {
    const error = MarketDataError.invalidAssetClass('invalid', 'test')
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withRetry(fn)).rejects.toThrow(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws after max attempts', async () => {
    const error = MarketDataError.providerTimeout('test', 5000)
    const fn = vi.fn().mockRejectedValue(error)

    const promise = withRetry(fn, { maxAttempts: 3, initialDelayMs: 100 })
    const timersPromise = vi.runAllTimersAsync()

    await expect(promise).rejects.toThrow(error)
    await timersPromise
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('uses exponential backoff', async () => {
    const error = MarketDataError.providerTimeout('test', 5000)
    const fn = vi.fn().mockRejectedValue(error)
    const onRetry = vi.fn()

    const promise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      onRetry,
    })
    const timersPromise = vi.runAllTimersAsync()

    await promise.catch(() => {})
    await timersPromise

    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, error, 1, 1000)
    expect(onRetry).toHaveBeenNthCalledWith(2, error, 2, 2000)
  })

  it('caps delay at maxDelayMs', async () => {
    const error = MarketDataError.providerTimeout('test', 5000)
    const fn = vi.fn().mockRejectedValue(error)
    const onRetry = vi.fn()

    const promise = withRetry(fn, {
      maxAttempts: 4,
      initialDelayMs: 1000,
      backoffMultiplier: 10,
      maxDelayMs: 5000,
      onRetry,
    })
    const timersPromise = vi.runAllTimersAsync()

    await promise.catch(() => {})
    await timersPromise

    expect(onRetry).toHaveBeenNthCalledWith(3, error, 3, 5000)
  })

  it('wraps non-MarketDataError as unknown error', async () => {
    const standardError = new Error('Standard error')
    const fn = vi.fn().mockRejectedValue(standardError)

    await expect(withRetry(fn)).rejects.toMatchObject({
      code: MarketDataErrorCode.UNKNOWN_ERROR,
      message: 'Standard error',
    })
  })
})
