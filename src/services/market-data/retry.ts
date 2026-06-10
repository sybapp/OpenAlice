import { MarketDataError } from './errors.js'

export interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  onRetry?: (error: MarketDataError, attempt: number, delayMs: number) => void
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
}

function calculateDelay(attempt: number, options: Required<Omit<RetryOptions, 'onRetry'>>): number {
  const delay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1)
  return Math.min(delay, options.maxDelayMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options }
  let lastError: MarketDataError | undefined

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const marketDataError = error instanceof MarketDataError
        ? error
        : MarketDataError.fromUnknown(error)

      lastError = marketDataError

      if (!marketDataError.isRetryable() || attempt === opts.maxAttempts) {
        throw marketDataError
      }

      const delayMs = calculateDelay(attempt, opts)
      options.onRetry?.(marketDataError, attempt, delayMs)
      await sleep(delayMs)
    }
  }

  throw lastError!
}
