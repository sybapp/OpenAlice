import type { MarketDataError } from './errors.js'

export interface MonitoringMetrics {
  requestCount: number
  errorCount: number
  retryCount: number
  totalLatencyMs: number
  errors: Array<{
    code: string
    provider: string
    timestamp: Date
  }>
}

export interface MonitoringHooks {
  onRequest?: (endpoint: string, provider: string) => void
  onSuccess?: (endpoint: string, provider: string, latencyMs: number) => void
  onError?: (endpoint: string, provider: string, error: MarketDataError, latencyMs: number) => void
  onRetry?: (endpoint: string, provider: string, error: MarketDataError, attempt: number) => void
  onRateLimit?: (provider: string, error: MarketDataError) => void
}

export class MarketDataMonitor {
  private metrics: Map<string, MonitoringMetrics> = new Map()
  private hooks: MonitoringHooks = {}

  setHooks(hooks: MonitoringHooks): void {
    this.hooks = { ...this.hooks, ...hooks }
  }

  trackRequest(endpoint: string, provider: string): () => void {
    const key = `${provider}:${endpoint}`
    const metrics = this.getOrCreateMetrics(key)
    metrics.requestCount++

    this.hooks.onRequest?.(endpoint, provider)
    const startTime = Date.now()

    return () => Date.now() - startTime
  }

  trackSuccess(endpoint: string, provider: string, latencyMs: number): void {
    const key = `${provider}:${endpoint}`
    const metrics = this.getOrCreateMetrics(key)
    metrics.totalLatencyMs += latencyMs

    this.hooks.onSuccess?.(endpoint, provider, latencyMs)
  }

  trackError(endpoint: string, provider: string, error: MarketDataError, latencyMs: number): void {
    const key = `${provider}:${endpoint}`
    const metrics = this.getOrCreateMetrics(key)
    metrics.errorCount++
    metrics.errors.push({
      code: error.code,
      provider: error.provider,
      timestamp: error.timestamp,
    })

    if (metrics.errors.length > 100) {
      metrics.errors.shift()
    }

    this.hooks.onError?.(endpoint, provider, error, latencyMs)

    if (error.code === 'RATE_LIMIT_EXCEEDED') {
      this.hooks.onRateLimit?.(provider, error)
    }
  }

  trackRetry(endpoint: string, provider: string, error: MarketDataError, attempt: number): void {
    const key = `${provider}:${endpoint}`
    const metrics = this.getOrCreateMetrics(key)
    metrics.retryCount++

    this.hooks.onRetry?.(endpoint, provider, error, attempt)
  }

  getMetrics(endpoint?: string, provider?: string): Map<string, MonitoringMetrics> {
    if (!endpoint && !provider) {
      return new Map(this.metrics)
    }

    const filtered = new Map<string, MonitoringMetrics>()
    for (const [key, value] of this.metrics.entries()) {
      const [keyProvider, keyEndpoint] = key.split(':')
      if ((!provider || keyProvider === provider) && (!endpoint || keyEndpoint === endpoint)) {
        filtered.set(key, value)
      }
    }
    return filtered
  }

  reset(): void {
    this.metrics.clear()
  }

  private getOrCreateMetrics(key: string): MonitoringMetrics {
    let metrics = this.metrics.get(key)
    if (!metrics) {
      metrics = {
        requestCount: 0,
        errorCount: 0,
        retryCount: 0,
        totalLatencyMs: 0,
        errors: [],
      }
      this.metrics.set(key, metrics)
    }
    return metrics
  }
}

export const globalMonitor = new MarketDataMonitor()
