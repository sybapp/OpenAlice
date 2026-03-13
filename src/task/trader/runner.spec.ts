import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../core/session.js'

const mocks = vi.hoisted(() => ({
  setSessionSkill: vi.fn(),
  buildTraderPrompt: vi.fn(),
  buildTraderSystemPrompt: vi.fn(),
  buildTraderReviewSummary: vi.fn(),
  getTraderStrategy: vi.fn(),
}))

vi.mock('../../core/skills/session-skill.js', () => ({
  setSessionSkill: mocks.setSessionSkill,
}))

vi.mock('./prompt.js', () => ({
  buildTraderPrompt: mocks.buildTraderPrompt,
  buildTraderSystemPrompt: mocks.buildTraderSystemPrompt,
  buildTraderReviewSummary: mocks.buildTraderReviewSummary,
}))

vi.mock('./strategy.js', () => ({
  getTraderStrategy: mocks.getTraderStrategy,
}))

const { runTraderJob, runTraderReview } = await import('./runner.js')

function makeDeps() {
  return {
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

describe('runTraderJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildTraderPrompt.mockReturnValue('trader prompt')
    mocks.buildTraderSystemPrompt.mockReturnValue('system prompt')
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
    mocks.getTraderStrategy.mockResolvedValue({
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: [], prohibitions: [] },
      executionPolicy: {
        allowedOrderTypes: ['stop'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })

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
    expect(deps.engine.askWithSession).not.toHaveBeenCalled()
  })

  it('skips when the strategy exists but is disabled', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      id: 'disabled',
      label: 'Disabled Strategy',
      enabled: false,
      sources: ['ccxt-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: [], prohibitions: [] },
      executionPolicy: {
        allowedOrderTypes: ['stop'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })
    const deps = makeDeps()

    const result = await runTraderJob({
      jobId: 'job-2',
      strategyId: 'disabled',
      session: { id: 'session-2' } as SessionStore,
    }, deps)

    expect(result).toEqual({
      status: 'skip',
      reason: 'Strategy disabled is disabled',
    })
    expect(deps.engine.askWithSession).not.toHaveBeenCalled()
  })

  it('builds a trader prompt, parses fenced JSON decisions, and updates brain notes', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
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
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValue({
      text: [
        'analysis...',
        '```json',
        JSON.stringify({
          status: 'trade',
          source: 'ccxt-main',
          symbol: 'BTC/USDT:USDT',
          chosenScenario: 'primary breakout continuation',
          rationale: 'Trend and pullback context align.',
          invalidation: ['loss of breakout level'],
          actionsTaken: ['stage long stop entry'],
          brainUpdate: 'Respect the breakout only after follow-through closes.',
        }),
        '```',
      ].join('\n'),
      media: [],
    })

    const session = { id: 'session-1' } as SessionStore
    const result = await runTraderJob({
      jobId: 'job-1',
      strategyId: 'momentum',
      session,
    }, deps)

    expect(mocks.setSessionSkill).toHaveBeenCalledWith(session, 'trader-auto')
    expect(mocks.buildTraderPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'momentum' }),
      expect.objectContaining({
        frontalLobe: 'stay selective',
        sourceSnapshots: [
          expect.objectContaining({
            source: 'ccxt-main',
          }),
        ],
      }),
    )
    expect(deps.engine.askWithSession).toHaveBeenCalledWith('trader prompt', session, {
      appendSystemPrompt: 'system prompt',
      historyPreamble: 'The following is the prior automated trader job history for this strategy.',
      maxHistoryEntries: 30,
    })
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith(
      'Respect the breakout only after follow-through closes.',
    )
    expect(result).toMatchObject({
      status: 'done',
      reason: 'Trend and pullback context align.',
      decision: {
        status: 'trade',
        strategyId: 'momentum',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'primary breakout continuation',
      },
    })
  })

  it('returns raw text when the trader response does not contain a valid decision object', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 2 },
      behaviorRules: { preferences: [], prohibitions: [] },
      executionPolicy: {
        allowedOrderTypes: ['stop'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValue({
      text: 'Context looks mixed. Stay patient.',
      media: [],
    })

    const result = await runTraderJob({
      jobId: 'job-3',
      strategyId: 'momentum',
      session: { id: 'session-3' } as SessionStore,
    }, deps)

    expect(result).toEqual({
      status: 'done',
      reason: 'Trader job completed',
      decision: undefined,
      rawText: 'Context looks mixed. Stay patient.',
    })
    expect(deps.brain.updateFrontalLobe).not.toHaveBeenCalled()
  })

  it('honors explicit skip decisions returned by the trader', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 2 },
      behaviorRules: { preferences: [], prohibitions: [] },
      executionPolicy: {
        allowedOrderTypes: ['stop'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValue({
      text: JSON.stringify({
        status: 'skip',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'no trade',
        rationale: 'Breakout context is too noisy.',
        invalidation: ['n/a'],
        actionsTaken: [],
        brainUpdate: '',
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
    expect(result.decision?.status).toBe('skip')
  })

  it('includes closed-market warnings in the equity trader prompt context', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      id: 'equity-open',
      label: 'Equity Open',
      enabled: true,
      sources: ['alpaca-main'],
      universe: { asset: 'equity', symbols: ['AAPL'] },
      timeframes: { context: '1d', structure: '1h', execution: '15m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 2 },
      behaviorRules: { preferences: [], prohibitions: [] },
      executionPolicy: {
        allowedOrderTypes: ['limit'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount({ marketClock: { isOpen: false } }))
    deps.engine.askWithSession.mockResolvedValue({
      text: 'Wait for the cash session to reopen.',
      media: [],
    })

    await runTraderJob({
      jobId: 'job-5',
      strategyId: 'equity-open',
      session: { id: 'session-5' } as SessionStore,
    }, deps)

    expect(mocks.buildTraderPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'equity-open' }),
      expect.objectContaining({
        warnings: expect.arrayContaining([
          'No configured equity source currently reports an open market clock.',
        ]),
      }),
    )
  })
})

describe('runTraderReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('summarizes trading history, updates brain, and writes a review event', async () => {
    mocks.buildTraderReviewSummary.mockReturnValue('Review summary text')
    const deps = makeDeps()
    deps.accountManager.listAccounts.mockReturnValue([{ id: 'ccxt-main' }])
    deps.getAccountGit.mockReturnValue({
      log: () => [
        {
          operations: [{ action: 'placeOrder', params: { symbol: 'BTC/USDT:USDT' } }],
          results: [{ success: true, status: 'filled', filledPrice: 100, filledQty: 1 }],
          stateAfter: { equity: 10_000, realizedPnL: 0 },
        },
        {
          operations: [{ action: 'closePosition', params: { symbol: 'BTC/USDT:USDT' } }],
          results: [{ success: true, status: 'filled', filledPrice: 110, filledQty: 1 }],
          stateAfter: { equity: 10_010, realizedPnL: 10 },
        },
      ],
    })

    const result = await runTraderReview(undefined, deps, {
      trigger: 'scheduled',
      jobId: 'review-1',
      jobName: 'Nightly Review',
    })

    expect(mocks.buildTraderReviewSummary).toHaveBeenCalledWith({
      strategyId: undefined,
      summaries: [
        {
          source: 'ccxt-main',
          summary: expect.stringContaining('1 trades'),
        },
      ],
    })
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith('Review summary text')
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

  it('limits reviews to strategy sources and records missing history cleanly', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      id: 'momentum',
      sources: ['ccxt-main', 'alpaca-paper'],
    })
    mocks.buildTraderReviewSummary.mockReturnValue('Scoped review summary')
    const deps = makeDeps()
    deps.accountManager.listAccounts.mockReturnValue([{ id: 'ignored-account' }])
    deps.getAccountGit.mockImplementation((source: string) => (
      source === 'ccxt-main'
        ? {
            log: () => [],
          }
        : undefined
    ))

    const result = await runTraderReview('momentum', deps)

    expect(mocks.buildTraderReviewSummary).toHaveBeenCalledWith({
      strategyId: 'momentum',
      summaries: [
        {
          source: 'ccxt-main',
          summary: '0 trades, winRate 0.0%, totalPnL 0.00, no closed trades yet',
        },
        {
          source: 'alpaca-paper',
          summary: 'No trading history available.',
        },
      ],
    })
    expect(result).toEqual({
      updated: true,
      summary: 'Scoped review summary',
      strategyId: 'momentum',
    })
  })
})
