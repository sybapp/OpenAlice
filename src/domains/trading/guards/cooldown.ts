import type { OperationGuard, GuardContext } from './types.js'
import { extractGuardSymbol } from './resolve-symbol.js'

const DEFAULT_MIN_INTERVAL_MS = 60_000

export class CooldownGuard implements OperationGuard {
  readonly name = 'cooldown'
  private minIntervalMs: number
  private now: () => number
  private lastTradeTime = new Map<string, number>()

  constructor(options: Record<string, unknown>) {
    this.minIntervalMs = Number(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)
    this.now = (options.now as (() => number) | undefined) ?? Date.now
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const symbol = extractGuardSymbol(ctx.operation)
    if (symbol == null) return null

    const now = this.now()
    const lastTime = this.lastTradeTime.get(symbol)

    if (lastTime != null) {
      const elapsed = now - lastTime
      if (elapsed < this.minIntervalMs) {
        const remaining = Math.ceil((this.minIntervalMs - elapsed) / 1000)
        return `Cooldown active for ${symbol}: ${remaining}s remaining`
      }
    }

    return null
  }

  onExecuted(ctx: GuardContext): void {
    if (ctx.operation.action !== 'placeOrder') return
    const symbol = extractGuardSymbol(ctx.operation)
    if (symbol == null) return
    this.lastTradeTime.set(symbol, this.now())
  }
}
