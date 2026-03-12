import type { OperationGuard, GuardContext } from './types.js'

export class BuyingPowerGuard implements OperationGuard {
  readonly name = 'buying-power'

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const notional = (ctx.operation.params.notional ?? ctx.operation.params.usd_size) as number | undefined
    if (!notional || notional <= 0) return null

    const buyingPower = ctx.account.cash
    if (buyingPower <= 0) {
      return `Insufficient buying power: $0 available, order requires $${notional.toFixed(2)}`
    }

    if (notional > buyingPower) {
      return `Order notional $${notional.toFixed(2)} exceeds buying power $${buyingPower.toFixed(2)}`
    }

    return null
  }
}
