import type { OperationGuard, GuardContext } from './types.js'

export class BuyingPowerGuard implements OperationGuard {
  readonly name = 'buying-power'

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const p = ctx.operation.params
    const notional = p.notional ?? p.usd_size
    const estimatedNotional = notional ?? (p.qty && p.price ? p.qty * p.price : undefined)
    if (!estimatedNotional || estimatedNotional <= 0) return null

    const buyingPower = ctx.account.buyingPower ?? ctx.account.cash
    if (buyingPower <= 0) {
      return `Insufficient buying power: $0 available, order requires $${estimatedNotional.toFixed(2)}`
    }

    if (estimatedNotional > buyingPower) {
      return `Order notional $${estimatedNotional.toFixed(2)} exceeds buying power $${buyingPower.toFixed(2)}`
    }

    return null
  }
}
