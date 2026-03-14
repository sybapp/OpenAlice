import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MaxPositionSizeGuard } from './max-position-size.js'
import { CooldownGuard } from './cooldown.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { BuyingPowerGuard } from './buying-power.js'
import { createGuardPipeline } from './guard-pipeline.js'
import { resolveGuards, registerGuard } from './registry.js'
import type { GuardContext, OperationGuard } from './types.js'
import type { Operation } from '../git/types.js'
import type { AccountInfo, Position } from '../interfaces.js'
import { MockTradingAccount, makePosition } from '../__test__/mock-account.js'

import { GuardContextCache } from './context-cache.js'

// ==================== Helpers ====================

function makeContext(overrides: {
  operation?: Operation
  positions?: Position[]
  account?: Partial<AccountInfo>
} = {}): GuardContext {
  return {
    operation: overrides.operation ?? {
      action: 'placeOrder',
      params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 },
    },
    positions: overrides.positions ?? [],
    account: {
      cash: 100_000,
      equity: 100_000,
      unrealizedPnL: 0,
      realizedPnL: 0,
      ...overrides.account,
    },
  }
}

// ==================== MaxPositionSizeGuard ====================

describe('MaxPositionSizeGuard', () => {
  it('allows order within limit', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 20_000 },
      },
      account: { equity: 100_000 },
    })

    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects order exceeding limit', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 30_000 },
      },
      account: { equity: 100_000 },
    })

    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
    expect(result).toContain('limit: 25%')
  })

  it('considers existing position value', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 10_000 },
      },
      positions: [makePosition({ contract: { symbol: 'AAPL' }, marketValue: 20_000 })],
      account: { equity: 100_000 },
    })

    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    // 20k existing + 10k new = 30k = 30%
    expect(result).toContain('30.0%')
  })

  it('uses default 25% if no option provided', () => {
    const guard = new MaxPositionSizeGuard({})
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 26_000 },
      },
      account: { equity: 100_000 },
    })
    expect(guard.check(ctx)).not.toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: { action: 'closePosition', params: { symbol: 'AAPL' } },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('allows when addedValue cannot be estimated (market order qty-based, no existing position, no price)', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'NEW_STOCK', side: 'buy', type: 'market', qty: 100 },
      },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('estimates value from qty + limit price for new symbol', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'NEW_STOCK', side: 'buy', type: 'limit', qty: 100, price: 300 },
      },
      account: { equity: 100_000 },
    })
    // 100 * 300 = 30_000 = 30% > 25%
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
  })

  it('allows placeOrder without symbol (cannot estimate, let broker validate)', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { aliceId: 'alpaca-AAPL', side: 'buy', type: 'market', notional: 50_000 },
      },
    })
    expect(guard.check(ctx)).toBeNull()
  })
})

describe('CooldownGuard', () => {
  it('allows first trade', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects rapid repeat trade for same symbol after onExecuted', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()

    guard.check(ctx) // first — allowed
    guard.onExecuted(ctx) // mark as executed
    const result = guard.check(ctx) // second — rejected
    expect(result).not.toBeNull()
    expect(result).toContain('Cooldown active')
    expect(result).toContain('AAPL')
  })

  it('does not consume cooldown when check passes but onExecuted is not called (rejected order)', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()

    guard.check(ctx) // first — allowed, but no onExecuted (simulating rejected order)
    const result = guard.check(ctx) // second — should still be allowed
    expect(result).toBeNull()
  })

  it('allows trade for different symbol', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })

    const ctx1 = makeContext({
      operation: { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } },
    })
    guard.check(ctx1)
    guard.onExecuted(ctx1)

    const result = guard.check(makeContext({
      operation: { action: 'placeOrder', params: { symbol: 'GOOG', side: 'buy', type: 'market', qty: 1 } },
    }))
    expect(result).toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext({
      operation: { action: 'closePosition', params: { symbol: 'AAPL' } },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('uses injected now() for time source', () => {
    let time = 1000
    const guard = new CooldownGuard({ minIntervalMs: 5_000, now: () => time })
    const ctx = makeContext()

    guard.check(ctx)
    guard.onExecuted(ctx)

    // Advance 3s — still in cooldown
    time = 4000
    expect(guard.check(ctx)).not.toBeNull()

    // Advance past cooldown
    time = 7000
    expect(guard.check(ctx)).toBeNull()
  })
})

// ==================== SymbolWhitelistGuard ====================

describe('SymbolWhitelistGuard', () => {
  it('allows whitelisted symbols', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL', 'GOOG'] })
    const ctx = makeContext()
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects non-whitelisted symbols', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['GOOG'] })
    const ctx = makeContext()
    expect(guard.check(ctx)).toContain('not in the allowed list')
  })

  it('throws on construction without symbols', () => {
    expect(() => new SymbolWhitelistGuard({})).toThrow('non-empty "symbols"')
    expect(() => new SymbolWhitelistGuard({ symbols: [] })).toThrow('non-empty "symbols"')
  })

  it('allows operations without a symbol param (cancelOrder)', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL'] })
    const ctx = makeContext({
      operation: { action: 'cancelOrder', params: { orderId: '123' } },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects placeOrder without symbol', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL'] })
    const ctx = makeContext({
      operation: { action: 'placeOrder', params: { aliceId: 'alpaca-AAPL', side: 'buy', type: 'market', qty: 1 } },
    })
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('Symbol required')
  })

  it('rejects closePosition without symbol', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL'] })
    const ctx = makeContext({
      operation: { action: 'closePosition', params: { aliceId: 'alpaca-AAPL' } },
    })
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('Symbol required')
  })
})

// ==================== Guard Pipeline ====================

describe('createGuardPipeline', () => {
  it('returns dispatcher directly when no guards', () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    const pipeline = createGuardPipeline(dispatcher, account, [])

    // Should be the same function reference
    expect(pipeline).toBe(dispatcher)
  })

  it('passes through when all guards allow', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    const allowGuard: OperationGuard = { name: 'allow-all', check: () => null }

    const pipeline = createGuardPipeline(dispatcher, account, [allowGuard])
    const op: Operation = { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } }
    const result = await pipeline(op)

    expect(dispatcher).toHaveBeenCalledWith(op)
    expect(result).toEqual({ success: true })
  })

  it('blocks when a guard rejects', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    const denyGuard: OperationGuard = { name: 'deny-all', check: () => 'Denied!' }

    const pipeline = createGuardPipeline(dispatcher, account, [denyGuard])
    const op: Operation = { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } }
    const result = await pipeline(op) as Record<string, unknown>

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('[guard:deny-all]')
    expect(result.error).toContain('Denied!')
  })

  it('stops at first rejecting guard', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    const guardA: OperationGuard = { name: 'A', check: vi.fn().mockReturnValue(null) }
    const guardB: OperationGuard = { name: 'B', check: vi.fn().mockReturnValue('Blocked by B') }
    const guardC: OperationGuard = { name: 'C', check: vi.fn().mockReturnValue(null) }

    const pipeline = createGuardPipeline(dispatcher, account, [guardA, guardB, guardC])
    const op: Operation = { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } }
    await pipeline(op)

    expect(guardA.check).toHaveBeenCalled()
    expect(guardB.check).toHaveBeenCalled()
    expect(guardC.check).not.toHaveBeenCalled()
  })

  it('fetches positions and account info for guard context', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    account.setPositions([makePosition()])

    let capturedCtx: GuardContext | undefined
    const spyGuard: OperationGuard = {
      name: 'spy',
      check: (ctx) => { capturedCtx = ctx; return null },
    }

    const pipeline = createGuardPipeline(dispatcher, account, [spyGuard])
    await pipeline({ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } })

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.positions).toHaveLength(1)
    expect(capturedCtx!.account.equity).toBe(105_000)
  })

  it('calls onExecuted on all guards after successful dispatch', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    const onExecutedA = vi.fn()
    const onExecutedB = vi.fn()
    const guardA: OperationGuard = { name: 'A', check: () => null, onExecuted: onExecutedA }
    const guardB: OperationGuard = { name: 'B', check: () => null, onExecuted: onExecutedB }

    const pipeline = createGuardPipeline(dispatcher, account, [guardA, guardB])
    await pipeline({ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } })

    expect(onExecutedA).toHaveBeenCalledTimes(1)
    expect(onExecutedB).toHaveBeenCalledTimes(1)
  })

  it('does not call onExecuted when guard rejects', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockTradingAccount()
    const onExecuted = vi.fn()
    const denyGuard: OperationGuard = { name: 'deny', check: () => 'Blocked', onExecuted }

    const pipeline = createGuardPipeline(dispatcher, account, [denyGuard])
    await pipeline({ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } })

    expect(onExecuted).not.toHaveBeenCalled()
  })
})

// ==================== Registry ====================

describe('resolveGuards', () => {
  it('resolves builtin guard types', () => {
    const guards = resolveGuards([
      { type: 'max-position-size', options: { maxPercentOfEquity: 25 } },
      { type: 'symbol-whitelist', options: { symbols: ['AAPL'] } },
    ])
    expect(guards).toHaveLength(2)
    expect(guards[0].name).toBe('max-position-size')
    expect(guards[1].name).toBe('symbol-whitelist')
  })

  it('skips unknown guard types with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guards = resolveGuards([{ type: 'nonexistent' }])
    expect(guards).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
    warnSpy.mockRestore()
  })

  it('returns empty for empty config', () => {
    expect(resolveGuards([])).toEqual([])
  })
})

describe('registerGuard', () => {
  it('registers a custom guard type', () => {
    registerGuard({
      type: 'test-custom',
      create: () => ({ name: 'test-custom', check: () => null }),
    })

    const guards = resolveGuards([{ type: 'test-custom' }])
    expect(guards).toHaveLength(1)
    expect(guards[0].name).toBe('test-custom')
  })
})

// ==================== BuyingPowerGuard ====================

describe('BuyingPowerGuard', () => {
  it('allows order within buying power', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 50_000 },
      },
      account: { cash: 100_000 },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects order exceeding buying power', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 150_000 },
      },
      account: { cash: 100_000 },
    })
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('exceeds buying power')
  })

  it('allows when no notional and no price specified (market order qty-based)', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 100 },
      },
      account: { cash: 100_000 },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects qty + limit price order exceeding buying power', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 100, price: 200 },
      },
      account: { cash: 10_000 },
    })
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('exceeds buying power')
    expect(result).toContain('20000')
  })

  it('prefers buyingPower field over cash', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 80_000 },
      },
      account: { cash: 50_000, buyingPower: 100_000 },
    })
    // cash=50k would reject, but buyingPower=100k allows
    expect(guard.check(ctx)).toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: { action: 'closePosition', params: { symbol: 'AAPL' } },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects when cash is zero', () => {
    const guard = new BuyingPowerGuard()
    const ctx = makeContext({
      operation: {
        action: 'placeOrder',
        params: { symbol: 'AAPL', side: 'buy', type: 'market', notional: 1000 },
      },
      account: { cash: 0 },
    })
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('Insufficient buying power')
  })

  it('is resolvable from registry', () => {
    const guards = resolveGuards([{ type: 'buying-power' }])
    expect(guards).toHaveLength(1)
    expect(guards[0].name).toBe('buying-power')
  })
})

// ==================== GuardContextCache ====================

describe('GuardContextCache', () => {
  it('caches positions and account within TTL', async () => {
    const account = new MockTradingAccount()
    const cache = new GuardContextCache(account, { ttlMs: 5000 })

    await cache.getPositions()
    await cache.getPositions()
    await cache.getAccount()
    await cache.getAccount()

    expect(account.getPositions).toHaveBeenCalledTimes(1)
    expect(account.getAccount).toHaveBeenCalledTimes(1)
  })

  it('refetches after invalidate()', async () => {
    const account = new MockTradingAccount()
    const cache = new GuardContextCache(account, { ttlMs: 5000 })

    await cache.getPositions()
    cache.invalidate()
    await cache.getPositions()

    expect(account.getPositions).toHaveBeenCalledTimes(2)
  })

  it('refetches after TTL expires', async () => {
    const account = new MockTradingAccount()
    const cache = new GuardContextCache(account, { ttlMs: 1 })

    await cache.getPositions()
    await new Promise((r) => setTimeout(r, 10))
    await cache.getPositions()

    expect(account.getPositions).toHaveBeenCalledTimes(2)
  })

  it('invalidates cache after each dispatch so next operation gets fresh data', async () => {
    const account = new MockTradingAccount()
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const passGuard: OperationGuard = { name: 'pass', check: () => null }

    const pipeline = createGuardPipeline(dispatcher, account, [passGuard])

    const op1: Operation = { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } }
    const op2: Operation = { action: 'placeOrder', params: { symbol: 'GOOG', side: 'buy', type: 'market', qty: 2 } }

    await pipeline(op1)
    await pipeline(op2)

    // Cache is invalidated after each dispatch, so each operation fetches fresh data
    expect(account.getPositions).toHaveBeenCalledTimes(2)
    expect(account.getAccount).toHaveBeenCalledTimes(2)
  })
})
