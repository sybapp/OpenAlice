import type { Operation } from '../git/types.js'

/** Extract symbol from operation params. Returns null if not resolvable. */
export function extractGuardSymbol(op: Operation): string | null {
  if (op.action === 'placeOrder') return op.params.symbol ?? null
  if (op.action === 'closePosition') return op.params.symbol ?? null
  return null
}
