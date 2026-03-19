import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../core/session.js'

const mocks = vi.hoisted(() => ({
  setSessionSkill: vi.fn(),
  getTraderStrategy: vi.fn(),
  getSkillScript: vi.fn(),
}))

vi.mock('../../skills/session-skill.js', () => ({
  setSessionSkill: mocks.setSessionSkill,
}))

vi.mock('../../skills/script-registry.js', () => ({
  getSkillScript: mocks.getSkillScript,
}))

vi.mock('./strategy.js', () => ({
  getTraderStrategy: mocks.getTraderStrategy,
}))

const { runTraderJob, runTraderReview } = await import('./runner.js')

function complete(output: unknown) {
  return { text: JSON.stringify({ type: 'complete', output }), media: [] }
}

function completeWrapped(output: unknown) {
  return { text: JSON.stringify({ text: { type: 'complete', output } }), media: [] }
}

function makeDeps() {
  return {
    config: {} as any,
    engine: {
      askWithSession: vi.fn(),
    },
    eventLog: {
      append: vi.fn(),
    },
    brain: {
      getFrontalLobe: vi.fn(() => 'stay selective'),
      updateFrontalLobe: vi.fn(),
    },
    accountManager: {
      getAccount: vi.fn(),
      listAccounts: vi.fn(() => []),
    },
    toolCenter: {} as any,
    marketData: {} as any,
    ohlcvStore: {} as any,
    newsStore: {} as any,
    getAccountGit: vi.fn(),
  } as any
}

function makeAccount(overrides?: {
  equity?: number
  positions?: Array<{ symbol?: string; marketValue: number; currentPrice?: number }>
  orders?: unknown[]
  marketClock?: unknown
}) {
  const equity = overrides?.equity ?? 10_000
  const positions = (overrides?.positions ?? [{ symbol: 'ETH/USDT:USDT', marketValue: 200, currentPrice: 200 }]).map((position) => ({
    contract: { symbol: position.symbol ?? 'ETH/USDT:USDT' },
    side: 'long' as const,
    qty: 1,
    avgEntryPrice: position.currentPrice ?? 200,
    currentPrice: position.currentPrice ?? 200,
    marketValue: position.marketValue,
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    costBasis: position.marketValue,
    leverage: 1,
  }))
  const orders = overrides?.orders ?? []
  return {
    getAccount: vi.fn(async () => ({
      cash: 5_000,
      equity,
      unrealizedPnL: 0,
      realizedPnL: 0,
    })),
    getPositions: vi.fn(async () => positions),
    getOrders: vi.fn(async () => orders),
    getMarketClock: vi.fn(async () => overrides?.marketClock ?? { isOpen: true }),
  }
}

const baseStrategy = {
  id: 'momentum',
  label: 'Momentum',
  enabled: true,
  sources: ['ccxt-main'],
  universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'] },
  timeframes: { context: '1h', structure: '15m', execution: '5m' },
  riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 2 },
  behaviorRules: {
    preferences: ['trend continuation'],
    prohibitions: ['no revenge trades'],
  },
  executionPolicy: {
    allowedOrderTypes: ['stop', 'stop_limit'],
    requireProtection: true,
    allowMarketOrders: false,
    allowOvernight: false,
  },
}

function queueHappyPath(deps: ReturnType<typeof makeDeps>, symbol = 'BTC/USDT:USDT') {
  deps.engine.askWithSession
    .mockResolvedValueOnce(complete({
      candidates: [{ source: 'ccxt-main', symbol, reason: 'best setup' }],
      summary: 'one good candidate',
    }))
    .mockResolvedValueOnce(complete({
      status: 'thesis_ready',
      source: 'ccxt-main',
      symbol,
      bias: 'long',
      chosenScenario: 'primary breakout continuation',
      alternateScenario: 'range failure',
      rationale: 'Trend and pullback context align.',
      invalidation: ['loss of breakout level'],
      confidence: 0.74,
      contextNotes: [],
    }))
    .mockResolvedValueOnce(complete({
      verdict: 'pass',
      source: 'ccxt-main',
      symbol,
      rationale: 'Risk budget is available.',
      maxRiskPercent: 0.5,
    }))
    .mockResolvedValueOnce(complete({
      status: 'plan_ready',
      source: 'ccxt-main',
      symbol,
      chosenScenario: 'primary breakout continuation',
      rationale: 'Trend and pullback context align.',
      invalidation: ['loss of breakout level'],
      commitMessage: `momentum: primary breakout continuation ${symbol}`,
      brainUpdate: 'Respect the breakout only after follow-through closes.',
      orders: [{
        aliceId: 'bybit-BTCUSDT',
        symbol,
        side: 'buy',
        type: 'stop',
        qty: 1,
        stopPrice: 100,
        timeInForce: 'day',
      }],
    }))
    .mockResolvedValueOnce(complete({
      status: 'execute',
      source: 'ccxt-main',
      symbol,
      rationale: 'Confirm execution.',
      brainUpdate: 'Execute only if the plan still matches structure.',
    }))
}

describe('runTraderJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when the strategy does not exist', async () => {
    mocks.getTraderStrategy.mockResolvedValue(null)
    const deps = makeDeps()

    const result = await runTraderJob({
      jobId: 'job-1',
      strategyId: 'missing',
      session: { id: 'session-1' } as SessionStore,
    }, deps)

    expect(result).toEqual({
      status: 'skip',
      reason: 'Unknown strategy: missing',
    })
    expect(deps.engine.askWithSession).not.toHaveBeenCalled()
  })

  it('skips when a configured source is unavailable', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(undefined)

    const result = await runTraderJob({
      jobId: 'job-1',
      strategyId: 'momentum',
      session: { id: 'session-1' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toContain('Configured source not available: ccxt-main')
    expect(mocks.setSessionSkill).not.toHaveBeenCalled()
  })

  it('rebuilds the account snapshot before the risk-check stage', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    const account = {
      getAccount: vi.fn()
        .mockResolvedValueOnce({ cash: 5_000, equity: 10_000, unrealizedPnL: 0, realizedPnL: 0 })
        .mockResolvedValueOnce({ cash: 4_800, equity: 9_600, unrealizedPnL: -100, realizedPnL: 0 }),
      getPositions: vi.fn()
        .mockResolvedValueOnce([{ contract: { symbol: 'ETH/USDT:USDT' }, side: 'long', qty: 1, avgEntryPrice: 2_000, currentPrice: 2_000, marketValue: 2_000, unrealizedPnL: 0, unrealizedPnLPercent: 0, costBasis: 2_000, leverage: 1 }])
        .mockResolvedValueOnce([{ contract: { symbol: 'ETH/USDT:USDT' }, side: 'long', qty: 1, avgEntryPrice: 2_000, currentPrice: 1_900, marketValue: 1_900, unrealizedPnL: -100, unrealizedPnLPercent: -5, costBasis: 2_000, leverage: 1 }]),
      getOrders: vi.fn().mockResolvedValue([]),
      getMarketClock: vi.fn().mockResolvedValue({ isOpen: true }),
    }
    deps.accountManager.getAccount.mockReturnValue(account)
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'primary breakout continuation',
        alternateScenario: 'range failure',
        rationale: 'Trend and pullback context align.',
        invalidation: ['loss of breakout level'],
        confidence: 0.74,
        contextNotes: [],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'fail',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Fresh snapshot says the account is too weak.',
        maxRiskPercent: 0.5,
      }))

    const result = await runTraderJob({
      jobId: 'job-risk-refresh',
      strategyId: 'momentum',
      session: { id: 'session-risk-refresh' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toBe('Fresh snapshot says the account is too weak.')
    expect(account.getAccount).toHaveBeenCalledTimes(2)
    expect(account.getPositions).toHaveBeenCalledTimes(2)
    expect(account.getOrders).toHaveBeenCalledTimes(2)
    expect(deps.engine.askWithSession.mock.calls[2][0]).toContain('"equity": 9600')
    expect(deps.engine.askWithSession.mock.calls[2][0]).toContain('"marketValue": 1900')
  })

  it('tries later scan candidates when the first one is rejected upstream', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({
        commit: { hash: 'abc12345' },
        pushed: { filled: [{ status: 'filled', orderId: 'ord-2', filledPrice: 100 }], pending: [], rejected: [] },
        commitDetails: { results: [{ status: 'filled', orderId: 'ord-2', filledPrice: 100 }] },
      })),
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [
          { source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'first setup' },
          { source: 'ccxt-main', symbol: 'ETH/USDT:USDT', reason: 'backup setup' },
        ],
        summary: 'two candidates',
      }))
      .mockResolvedValueOnce(complete({
        status: 'no_trade',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'flat',
        chosenScenario: 'stand aside',
        rationale: 'BTC setup degraded.',
        invalidation: ['n/a'],
        confidence: 0.2,
        contextNotes: ['Skip the first candidate.'],
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'ccxt-main',
        symbol: 'ETH/USDT:USDT',
        bias: 'long',
        chosenScenario: 'secondary breakout',
        alternateScenario: 'range failure',
        rationale: 'ETH still qualifies.',
        invalidation: ['lose range low'],
        confidence: 0.6,
        contextNotes: [],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'pass',
        source: 'ccxt-main',
        symbol: 'ETH/USDT:USDT',
        rationale: 'Risk budget remains available.',
        maxRiskPercent: 0.5,
      }))
      .mockResolvedValueOnce(complete({
        status: 'plan_ready',
        source: 'ccxt-main',
        symbol: 'ETH/USDT:USDT',
        chosenScenario: 'secondary breakout',
        rationale: 'ETH still qualifies.',
        invalidation: ['lose range low'],
        commitMessage: 'momentum: secondary breakout ETH/USDT:USDT',
        brainUpdate: 'ETH only after BTC degrades.',
        orders: [{
          aliceId: 'bybit-ETHUSDT',
          symbol: 'ETH/USDT:USDT',
          side: 'buy',
          type: 'stop',
          qty: 1,
          stopPrice: 100,
          timeInForce: 'day',
        }],
      }))
      .mockResolvedValueOnce(complete({
        status: 'execute',
        source: 'ccxt-main',
        symbol: 'ETH/USDT:USDT',
        rationale: 'Confirm execution.',
        brainUpdate: 'Execute the backup setup.',
      }))

    const result = await runTraderJob({
      jobId: 'job-candidate-fallback',
      strategyId: 'momentum',
      session: { id: 'session-candidate-fallback' } as SessionStore,
    }, deps)

    expect(result).toMatchObject({
      status: 'done',
      decision: {
        symbol: 'ETH/USDT:USDT',
        chosenScenario: 'secondary breakout',
      },
    })
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith('Skip the first candidate.')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(3, expect.objectContaining({ id: 'session-candidate-fallback' }), 'trader-trade-thesis')
  })

  it('blocks plan execution when hard maxPositions would be breached', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      riskBudget: { ...baseStrategy.riskBudget, maxPositions: 1 },
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount({
      positions: [{ symbol: 'ETH/USDT:USDT', marketValue: 2_000, currentPrice: 2_000 }],
    }))
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'primary breakout continuation',
        alternateScenario: 'range failure',
        rationale: 'Trend and pullback context align.',
        invalidation: ['loss of breakout level'],
        confidence: 0.74,
        contextNotes: [],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'pass',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Risk budget is available.',
        maxRiskPercent: 0.5,
      }))
      .mockResolvedValueOnce(complete({
        status: 'plan_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'primary breakout continuation',
        rationale: 'Trend and pullback context align.',
        invalidation: ['loss of breakout level'],
        commitMessage: 'momentum: primary breakout continuation BTC/USDT:USDT',
        brainUpdate: 'Do not overtrade a full book.',
        orders: [{
          aliceId: 'bybit-BTCUSDT',
          symbol: 'BTC/USDT:USDT',
          side: 'buy',
          type: 'stop',
          qty: 1,
          stopPrice: 100,
          timeInForce: 'day',
        }],
      }))

    const result = await runTraderJob({
      jobId: 'job-hard-risk',
      strategyId: 'momentum',
      session: { id: 'session-hard-risk' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toContain('Hard risk gate blocked execution')
    expect(deps.engine.askWithSession).toHaveBeenCalledTimes(4)
    expect(mocks.getSkillScript).not.toHaveBeenCalled()
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith('Do not overtrade a full book.')
  })

  it('treats the same symbol on another source as a new position for maxPositions', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      sources: ['ccxt-main', 'ccxt-hedge'],
      riskBudget: { ...baseStrategy.riskBudget, maxPositions: 1 },
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockImplementation((source: string) => {
      if (source === 'ccxt-main') {
        return makeAccount({
          positions: [{ symbol: 'BTC/USDT:USDT', marketValue: 200, currentPrice: 200 }],
        })
      }
      if (source === 'ccxt-hedge') {
        return makeAccount({ positions: [] })
      }
      return undefined
    })
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-hedge', symbol: 'BTC/USDT:USDT', reason: 'hedge venue has the setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'ccxt-hedge',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'secondary venue breakout',
        alternateScenario: 'range failure',
        rationale: 'Setup is valid on the hedge venue.',
        invalidation: ['loss of breakout level'],
        confidence: 0.74,
        contextNotes: [],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'pass',
        source: 'ccxt-hedge',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Risk budget is available.',
        maxRiskPercent: 0.5,
      }))
      .mockResolvedValueOnce(complete({
        status: 'plan_ready',
        source: 'ccxt-hedge',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'secondary venue breakout',
        rationale: 'Setup is valid on the hedge venue.',
        invalidation: ['loss of breakout level'],
        commitMessage: 'momentum: secondary venue breakout BTC/USDT:USDT',
        brainUpdate: 'Do not bypass the max position cap across venues.',
        orders: [{
          aliceId: 'hedge-BTCUSDT',
          symbol: 'BTC/USDT:USDT',
          side: 'buy',
          type: 'stop',
          qty: 1,
          stopPrice: 100,
          timeInForce: 'day',
        }],
      }))

    const result = await runTraderJob({
      jobId: 'job-cross-source-max-positions',
      strategyId: 'momentum',
      session: { id: 'session-cross-source-max-positions' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toContain('Hard risk gate blocked execution: current positions 1 already meet/exceed maxPositions 1.')
    expect(deps.engine.askWithSession).toHaveBeenCalledTimes(4)
    expect(mocks.getSkillScript).not.toHaveBeenCalled()
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith('Do not bypass the max position cap across venues.')
  })

  it('persists the combined brain update before the execution script runs', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => {
        throw new Error('exchange refused the batch')
      }),
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    queueHappyPath(deps)

    await expect(runTraderJob({
      jobId: 'job-brain-first',
      strategyId: 'momentum',
      session: { id: 'session-brain-first' } as SessionStore,
    }, deps)).rejects.toThrow('exchange refused the batch')

    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith(
      'Respect the breakout only after follow-through closes.\nExecute only if the plan still matches structure.',
    )
  })

  it('reports actual execution results instead of echoing the planned orders', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({
        commit: { hash: 'abc12345' },
        pushed: {
          filled: [{ status: 'filled', orderId: 'ord-1', filledPrice: 100 }],
          pending: [],
          rejected: [{ status: 'rejected', orderId: 'ord-2', error: 'post only would cross' }],
        },
        commitDetails: {
          results: [
            { status: 'filled', orderId: 'ord-1', filledPrice: 100 },
            { status: 'rejected', orderId: 'ord-2', error: 'post only would cross' },
          ],
        },
      })),
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount({ positions: [] }))
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'ladder breakout',
        alternateScenario: 'range failure',
        rationale: 'Trend and pullback context align.',
        invalidation: ['loss of breakout level'],
        confidence: 0.74,
        contextNotes: [],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'pass',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Risk budget is available.',
        maxRiskPercent: 0.5,
      }))
      .mockResolvedValueOnce(complete({
        status: 'plan_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'ladder breakout',
        rationale: 'Trend and pullback context align.',
        invalidation: ['loss of breakout level'],
        commitMessage: 'momentum: ladder breakout BTC/USDT:USDT',
        brainUpdate: 'Stagger entries only.',
        orders: [
          {
            aliceId: 'bybit-BTCUSDT-entry-1',
            symbol: 'BTC/USDT:USDT',
            side: 'buy',
            type: 'stop',
            qty: 1,
            stopPrice: 100,
            timeInForce: 'day',
          },
          {
            aliceId: 'bybit-BTCUSDT-entry-2',
            symbol: 'BTC/USDT:USDT',
            side: 'buy',
            type: 'stop',
            qty: 1,
            stopPrice: 101,
            timeInForce: 'day',
          },
        ],
      }))
      .mockResolvedValueOnce(complete({
        status: 'execute',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Confirm execution.',
        brainUpdate: 'Execute if both ladder levels still make sense.',
      }))

    const result = await runTraderJob({
      jobId: 'job-actual-results',
      strategyId: 'momentum',
      session: { id: 'session-actual-results' } as SessionStore,
    }, deps)

    expect(result).toMatchObject({
      status: 'done',
      reason: 'Execution completed with issues: 1 filled, 0 pending, 1 rejected.',
      decision: {
        rationale: 'Execution completed with issues: 1 filled, 0 pending, 1 rejected.',
      },
    })
    expect(result.decision?.actionsTaken).toEqual([
      'Executed deterministic trade plan: momentum: ladder breakout BTC/USDT:USDT (abc12345)',
      'BUY stop BTC/USDT:USDT qty=1 stop=100 -> filled @100 (ord-1)',
      'BUY stop BTC/USDT:USDT qty=1 stop=101 -> rejected: post only would cross',
    ])
  })

  it('returns skip when the thesis stage rejects the setup', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'no_trade',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'flat',
        chosenScenario: 'no trade',
        rationale: 'Breakout context is too noisy.',
        invalidation: ['n/a'],
        confidence: 0.2,
        contextNotes: ['Wait for cleaner structure.'],
      }))

    const result = await runTraderJob({
      jobId: 'job-4',
      strategyId: 'momentum',
      session: { id: 'session-4' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toBe('Breakout context is too noisy.')
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith('Wait for cleaner structure.')
  })

  it('accepts trade-plan skip payloads without commitMessage or orders', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'primary breakout continuation',
        alternateScenario: 'range failure',
        rationale: 'Trend and pullback context align.',
        invalidation: ['loss of breakout level'],
        confidence: 0.74,
        contextNotes: [],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'pass',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Risk budget is available.',
        maxRiskPercent: 0.5,
      }))
      .mockResolvedValueOnce(completeWrapped({
        status: 'skip',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'primary breakout continuation',
        rationale: 'Trigger is not confirmed yet.',
        invalidation: ['loss of breakout level'],
        brainUpdate: 'Wait for confirmation.',
      }))

    const result = await runTraderJob({
      jobId: 'job-4b',
      strategyId: 'momentum',
      session: { id: 'session-4b' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toBe('Trigger is not confirmed yet.')
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith('Wait for confirmation.')
    expect(mocks.getSkillScript).not.toHaveBeenCalled()
  })

  it('parses skill-loop responses wrapped under text.complete output', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce(completeWrapped({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(completeWrapped({
        status: 'no_trade',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'flat',
        chosenScenario: 'stand aside',
        rationale: 'Wrapped completion parsed correctly.',
        invalidation: ['n/a'],
        confidence: 0.2,
        contextNotes: [],
      }))

    const result = await runTraderJob({
      jobId: 'job-5',
      strategyId: 'momentum',
      session: { id: 'session-5' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')
    expect(result.reason).toBe('Wrapped completion parsed correctly.')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'session-5' }), 'trader-market-scan')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'session-5' }), 'trader-trade-thesis')
  })
})

describe('runTraderReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates brain and writes a review event from the review skill result', async () => {
    const deps = makeDeps()
    deps.accountManager.listAccounts.mockReturnValue([{ id: 'ccxt-main' }])
    deps.engine.askWithSession.mockResolvedValue(complete({
      summary: 'Review summary text',
      brainUpdate: 'Stay selective and keep sizing small after mixed outcomes.',
    }))

    const result = await runTraderReview(undefined, deps, {
      trigger: 'scheduled',
      jobId: 'review-1',
      jobName: 'Nightly Review',
    })

    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith(
      'Stay selective and keep sizing small after mixed outcomes.',
    )
    expect(deps.eventLog.append).toHaveBeenCalledWith('trader.review.done', {
      strategyId: undefined,
      trigger: 'scheduled',
      jobId: 'review-1',
      jobName: 'Nightly Review',
      updated: true,
      summary: 'Review summary text',
    })
    expect(result).toEqual({
      updated: true,
      summary: 'Review summary text',
      strategyId: undefined,
    })
  })
})
