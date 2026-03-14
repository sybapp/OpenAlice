/**
 * Guard Pipeline
 *
 * The only place that touches the account: assembles a GuardContext,
 * then passes it through the guard chain. Guards themselves never
 * see the account.
 */

import type { Operation } from '../git/types.js'
import type { ITradingAccount } from '../interfaces.js'
import type { OperationGuard, GuardContext } from './types.js'
import { GuardContextCache, type GuardContextCacheOptions } from './context-cache.js'

export function createGuardPipeline(
  dispatcher: (op: Operation) => Promise<unknown>,
  account: ITradingAccount,
  guards: OperationGuard[],
  cacheOptions?: GuardContextCacheOptions,
): (op: Operation) => Promise<unknown> {
  if (guards.length === 0) return dispatcher

  const cache = new GuardContextCache(account, cacheOptions)

  return async (op: Operation): Promise<unknown> => {
    const [positions, accountInfo] = await Promise.all([
      cache.getPositions(),
      cache.getAccount(),
    ])

    const ctx: GuardContext = { operation: op, positions, account: accountInfo }

    for (const guard of guards) {
      const rejection = await guard.check(ctx)
      if (rejection != null) {
        return { success: false, error: `[guard:${guard.name}] ${rejection}` }
      }
    }

    const result = await dispatcher(op)
    cache.invalidate()
    for (const guard of guards) {
      guard.onExecuted?.(ctx)
    }
    return result
  }
}
