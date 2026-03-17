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
    getAccountGit: vi.fn(),
  } as any
}

function makeAccount(overrides?: {
  equity?: number
  positions?: Array<{ marketValue: number }>
  orders?: unknown[]
  marketClock?: unknown
}) {
  const equity = overrides?.equity ?? 10_000
  const positions = overrides?.positions ?? [{ marketValue: 2_000 }]
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
  universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
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

  it('runs the staged trader pipeline and executes the deterministic trade plan', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({ commit: { hash: 'abc12345' }, pushed: { executed: 1 } })),
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
            summary: 'one good candidate',
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
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
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            verdict: 'pass',
            source: 'ccxt-main',
            symbol: 'BTC/USDT:USDT',
            rationale: 'Risk budget is available.',
            maxRiskPercent: 0.5,
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            status: 'plan_ready',
            source: 'ccxt-main',
            symbol: 'BTC/USDT:USDT',
            chosenScenario: 'primary breakout continuation',
            rationale: 'Trend and pullback context align.',
            invalidation: ['loss of breakout level'],
            commitMessage: 'momentum: primary breakout continuation BTC/USDT:USDT',
            brainUpdate: 'Respect the breakout only after follow-through closes.',
            orders: [{
              aliceId: 'bybit-BTCUSDT',
              symbol: 'BTC/USDT:USDT',
              side: 'buy',
              type: 'stop',
              qty: 1,
              stopPrice: 100,
              timeInForce: 'day',
            }],
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            status: 'execute',
            source: 'ccxt-main',
            symbol: 'BTC/USDT:USDT',
            rationale: 'Confirm execution.',
            brainUpdate: 'Execute only if the plan still matches structure.',
          },
        }),
        media: [],
      })

    const session = { id: 'session-1' } as SessionStore
    const result = await runTraderJob({
      jobId: 'job-1',
      strategyId: 'momentum',
      session,
    }, deps)

    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(1, session, 'trader-market-scan')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(2, session, 'trader-trade-thesis')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(3, session, 'trader-risk-check')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(4, session, 'trader-trade-plan')
    expect(mocks.setSessionSkill).toHaveBeenNthCalledWith(5, session, 'trader-trade-execute')
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith(
      'Respect the breakout only after follow-through closes.\nExecute only if the plan still matches structure.',
    )
    expect(result).toMatchObject({
      status: 'done',
      reason: 'Confirm execution.',
      decision: {
        status: 'trade',
        strategyId: 'momentum',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'primary breakout continuation',
      },
    })
  })

  it('returns skip when the thesis stage rejects the setup', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
            summary: 'one good candidate',
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            status: 'no_trade',
            source: 'ccxt-main',
            symbol: 'BTC/USDT:USDT',
            bias: 'flat',
            chosenScenario: 'no trade',
            rationale: 'Breakout context is too noisy.',
            invalidation: ['n/a'],
            confidence: 0.2,
            contextNotes: ['Wait for cleaner structure.'],
          },
        }),
        media: [],
      })

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
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
            summary: 'one good candidate',
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
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
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: 'complete',
          output: {
            verdict: 'pass',
            source: 'ccxt-main',
            symbol: 'BTC/USDT:USDT',
            rationale: 'Risk budget is available.',
            maxRiskPercent: 0.5,
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          text: {
            type: 'complete',
            output: {
              status: 'skip',
              source: 'ccxt-main',
              symbol: 'BTC/USDT:USDT',
              chosenScenario: 'primary breakout continuation',
              rationale: 'Trigger is not confirmed yet.',
              invalidation: ['loss of breakout level'],
              brainUpdate: 'Wait for confirmation.',
            },
          },
        }),
        media: [],
      })

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
      .mockResolvedValueOnce({
        text: JSON.stringify({
          text: {
            type: 'complete',
            output: {
              candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
              summary: 'one good candidate',
            },
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          text: {
            type: 'complete',
            output: {
              status: 'no_trade',
              source: 'ccxt-main',
              symbol: 'BTC/USDT:USDT',
              bias: 'flat',
              chosenScenario: 'stand aside',
              rationale: 'Wrapped completion parsed correctly.',
              invalidation: ['n/a'],
              confidence: 0.2,
              contextNotes: [],
            },
          },
        }),
        media: [],
      })

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
    deps.engine.askWithSession.mockResolvedValue({
      text: JSON.stringify({
        type: 'complete',
        output: {
          summary: 'Review summary text',
          brainUpdate: 'Stay selective and keep sizing small after mixed outcomes.',
        },
      }),
      media: [],
    })

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
