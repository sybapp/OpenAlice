import type { MarketDataError } from './errors.js'

export interface MetricsSnapshot {
  successRate: number
  avgResponseTimeMs: number
  totalRequests: number
  successCount: number
  errorCount: number
  connectionHealthy: boolean
  errorsByCode: Record<string, number>
  providerHealth: Record<string, {
    healthy: boolean
    successRate: number
    avgLatencyMs: number
  }>
}

export class MetricsCollector {
  private requests = 0
  private successes = 0
  private errors = 0
  private totalLatency = 0
  private errorCodes = new Map<string, number>()
  private providerStats = new Map<string, { successes: number; errors: number; latency: number }>()

  recordSuccess(provider: string, latencyMs: number): void {
    this.requests++
    this.successes++
    this.totalLatency += latencyMs

    const stats = this.getProviderStats(provider)
    stats.successes++
    stats.latency += latencyMs
  }

  recordError(provider: string, error: MarketDataError, latencyMs: number): void {
    this.requests++
    this.errors++
    this.totalLatency += latencyMs

    const count = this.errorCodes.get(error.code) || 0
    this.errorCodes.set(error.code, count + 1)

    const stats = this.getProviderStats(provider)
    stats.errors++
    stats.latency += latencyMs
  }

  snapshot(): MetricsSnapshot {
    const successRate = this.requests > 0 ? this.successes / this.requests : 0
    const avgResponseTimeMs = this.requests > 0 ? this.totalLatency / this.requests : 0
    const connectionHealthy = successRate >= 0.8

    const errorsByCode: Record<string, number> = {}
    for (const [code, count] of this.errorCodes) {
      errorsByCode[code] = count
    }

    const providerHealth: Record<string, { healthy: boolean; successRate: number; avgLatencyMs: number }> = {}
    for (const [provider, stats] of this.providerStats) {
      const total = stats.successes + stats.errors
      const successRate = total > 0 ? stats.successes / total : 0
      const avgLatencyMs = total > 0 ? stats.latency / total : 0
      providerHealth[provider] = {
        healthy: successRate >= 0.8,
        successRate,
        avgLatencyMs,
      }
    }

    return {
      successRate,
      avgResponseTimeMs,
      totalRequests: this.requests,
      successCount: this.successes,
      errorCount: this.errors,
      connectionHealthy,
      errorsByCode,
      providerHealth,
    }
  }

  reset(): void {
    this.requests = 0
    this.successes = 0
    this.errors = 0
    this.totalLatency = 0
    this.errorCodes.clear()
    this.providerStats.clear()
  }

  private getProviderStats(provider: string) {
    let stats = this.providerStats.get(provider)
    if (!stats) {
      stats = { successes: 0, errors: 0, latency: 0 }
      this.providerStats.set(provider, stats)
    }
    return stats
  }
}

export const globalMetrics = new MetricsCollector()
