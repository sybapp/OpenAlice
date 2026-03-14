import type { OperationGuard, GuardContext } from './types.js'
import { extractGuardSymbol } from './resolve-symbol.js'

export class SymbolWhitelistGuard implements OperationGuard {
  readonly name = 'symbol-whitelist'
  private allowed: Set<string>

  constructor(options: Record<string, unknown>) {
    const symbols = options.symbols as string[] | undefined
    if (!symbols || symbols.length === 0) {
      throw new Error('symbol-whitelist guard requires a non-empty "symbols" array in options')
    }
    this.allowed = new Set(symbols)
  }

  check(ctx: GuardContext): string | null {
    const symbol = extractGuardSymbol(ctx.operation)
    if (symbol == null) {
      // Symbol-bearing actions (placeOrder, closePosition) without a symbol must be rejected
      if (ctx.operation.action === 'placeOrder' || ctx.operation.action === 'closePosition') {
        return 'Symbol required for whitelist check'
      }
      return null
    }

    if (!this.allowed.has(symbol)) {
      return `Symbol ${symbol} is not in the allowed list`
    }
    return null
  }
}
