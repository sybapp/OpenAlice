import type { OperationGuard, GuardContext } from './types.js'
import { extractGuardSymbol } from './resolve-symbol.js'

const DEFAULT_MAX_PERCENT = 25

export class MaxPositionSizeGuard implements OperationGuard {
  readonly name = 'max-position-size'
  private maxPercent: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const { positions, account, operation } = ctx
    const p = operation.params
    const symbol = extractGuardSymbol(ctx.operation)

    // Can't estimate without symbol — let broker validate
    if (symbol == null) return null

    const existing = positions.find(pos => pos.contract.symbol === symbol)
    const currentValue = existing?.marketValue ?? 0

    // Estimate added value from either notional- or quantity-based order params.
    const dollarAmount = p.notional ?? p.usd_size
    const quantity = p.qty ?? p.size

    let addedValue = 0
    if (dollarAmount) {
      addedValue = dollarAmount
    } else if (quantity && existing) {
      addedValue = quantity * existing.currentPrice
    } else if (quantity && p.price) {
      addedValue = quantity * p.price
    }
    // If we can't estimate (new symbol + market order qty-based without existing position), allow — broker will validate

    if (addedValue === 0) return null

    const currentExposure = existing
      ? (existing.side === 'short' ? -currentValue : currentValue)
      : 0
    const deltaExposure = p.side === 'sell' ? -addedValue : addedValue
    const projectedValue = Math.abs(currentExposure + deltaExposure)
    const percent = account.equity > 0 ? (projectedValue / account.equity) * 100 : 0

    if (percent > this.maxPercent) {
      return `Position for ${symbol} would be ${percent.toFixed(1)}% of equity (limit: ${this.maxPercent}%)`
    }

    return null
  }
}
