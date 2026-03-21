import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../core/session.js'

const mocks = vi.hoisted(() => ({
  setSessionSkill: vi.fn(),
  getTraderStrategy: vi.fn(),
  applyTraderStrategyPatch: vi.fn(),
  getSkillScript: vi.fn(),
}))

vi.mock('../../skills/session-skill.js', () => ({
  setSessionSkill: mocks.setSessionSkill,
}))

vi.mock('../../skills/script-registry.js', () => ({
  getSkillScript: mocks.getSkillScript,
}))

vi.mock('./strategy.js', () => ({
  applyTraderStrategyPatch: mocks.applyTraderStrategyPatch,
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
  label?: string
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
    label: overrides?.label ?? 'Main Account',
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

function buildCoverageEvaluations(params: {
  source: string
  symbols: string[]
  candidateSymbol?: string
  candidateReason?: string
  skipReason?: string
}) {
  return params.symbols.map((symbol) => ({
    source: params.source,
    symbol,
    verdict: symbol === params.candidateSymbol ? 'candidate' : 'skip',
    reason: symbol === params.candidateSymbol
      ? (params.candidateReason ?? 'best setup')
      : (params.skipReason ?? 'Not selected this pass.'),
  }))
}

  function queueHappyPath(deps: ReturnType<typeof makeDeps>, symbol = 'BTC/USDT:USDT') {
  deps.engine.askWithSession
    .mockResolvedValueOnce(complete({
      candidates: [{ source: 'ccxt-main', symbol, reason: 'best setup' }],
      evaluations: buildCoverageEvaluations({
        source: 'ccxt-main',
        symbols: baseStrategy.universe.symbols,
        candidateSymbol: symbol,
      }),
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
    mocks.applyTraderStrategyPatch.mockResolvedValue({
      strategy: baseStrategy,
      patchApplied: true,
      changeReport: {
        changedFields: ['preferences'],
        summary: 'Review updated preferences.',
        yamlDiff: '- behaviorRules:\n+ behaviorRules:',
      },
    })
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

  it('uses market-scan evaluations as the skip reason when no candidates are returned', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      id: 'mean-revert',
      label: 'Mean Revert',
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValueOnce(complete({
      candidates: [],
      evaluations: [{
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        verdict: 'skip',
        reason: 'No confirmed rejection candle on 5m.',
      }],
      summary: '',
    }))

    const result = await runTraderJob({
      jobId: 'job-single-symbol-empty-scan',
      strategyId: 'mean-revert',
      session: { id: 'session-single-symbol-empty-scan' } as SessionStore,
    }, deps)

    expect(result).toEqual({
      status: 'skip',
      reason: 'BTC/USDT:USDT on Main Account: No confirmed rejection candle on 5m.',
      decision: undefined,
      rawText: JSON.stringify({ type: 'complete', output: {
        candidates: [],
        evaluations: [{
          source: 'Main Account',
          symbol: 'BTC/USDT:USDT',
          verdict: 'skip',
          reason: 'No confirmed rejection candle on 5m.',
        }],
        summary: '',
      } }),
    })
  })

  it('preserves an explicit single-symbol market-scan summary when no candidates are returned', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      id: 'mean-revert',
      label: 'Mean Revert',
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValueOnce(complete({
      candidates: [],
      evaluations: [{
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        verdict: 'skip',
        reason: 'Current structure violates the mean-reversion entry rules.',
      }],
      summary: 'BTC/USDT:USDT is the only symbol, but current structure violates the mean-reversion entry rules.',
    }))

    const result = await runTraderJob({
      jobId: 'job-single-symbol-summary',
      strategyId: 'mean-revert',
      session: { id: 'session-single-symbol-summary' } as SessionStore,
    }, deps)

    expect(result).toMatchObject({
      status: 'skip',
      reason: 'BTC/USDT:USDT is the only symbol, but current structure violates the mean-reversion entry rules.',
    })
  })

  it('rejects an all-empty market-scan payload', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValueOnce(complete({
      candidates: [],
      evaluations: [],
      summary: '',
    }))

    await expect(runTraderJob({
      jobId: 'job-empty-scan',
      strategyId: 'momentum',
      session: { id: 'session-empty-scan' } as SessionStore,
    }, deps)).rejects.toThrow('Market scan cannot return an all-empty payload.')
  })

  it('rejects market-scan payloads that miss configured coverage', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValueOnce(complete({
      candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
      evaluations: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', verdict: 'candidate', reason: 'best setup' }],
      summary: 'incomplete coverage',
    }))

    await expect(runTraderJob({
      jobId: 'job-coverage-gap',
      strategyId: 'momentum',
      session: { id: 'session-coverage-gap' } as SessionStore,
    }, deps)).rejects.toThrow('Market scan is missing explicit evaluations for: ccxt-main::ETH/USDT:USDT')
  })

  it('rejects single-symbol scans that skip the explicit evaluation', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      id: 'mean-revert',
      label: 'Mean Revert',
      universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession.mockResolvedValueOnce(complete({
      candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
      evaluations: [],
      summary: 'single symbol looks interesting',
    }))

    await expect(runTraderJob({
      jobId: 'job-single-missing-eval',
      strategyId: 'mean-revert',
      session: { id: 'session-single-missing-eval' } as SessionStore,
    }, deps)).rejects.toThrow('Market scan is missing explicit evaluations for: ccxt-main::BTC/USDT:USDT')
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
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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

  it('masks real trading source ids before sending trader prompts to the model', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      sources: ['paper-1'],
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'source-1', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        evaluations: buildCoverageEvaluations({
          source: 'source-1',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
        summary: 'one good candidate',
      }))
      .mockResolvedValueOnce(complete({
        status: 'no_trade',
        source: 'source-1',
        symbol: 'BTC/USDT:USDT',
        bias: 'flat',
        chosenScenario: 'no trade',
        rationale: 'Stand aside.',
        invalidation: ['n/a'],
        confidence: 0.2,
        contextNotes: [],
      }))

    const result = await runTraderJob({
      jobId: 'job-masked-source',
      strategyId: 'momentum',
      session: { id: 'session-masked-source' } as SessionStore,
    }, deps)

    expect(result.status).toBe('skip')

    const scanPrompt = String(deps.engine.askWithSession.mock.calls[0][0])
    const thesisPrompt = String(deps.engine.askWithSession.mock.calls[1][0])
    expect(scanPrompt).toContain('source-1')
    expect(scanPrompt).not.toContain('paper-1')
    expect(thesisPrompt).toContain('source-1')
    expect(thesisPrompt).not.toContain('paper-1')

    const scanOptions = deps.engine.askWithSession.mock.calls[0][2]
    expect(scanOptions.skillContext.strategy.sources).toEqual(['source-1'])
    expect(scanOptions.skillContext.__sourceAliases.aliasToReal).toEqual({ 'source-1': 'paper-1' })
  })

  it('returns user-facing source labels instead of internal aliases or source ids', async () => {
    mocks.getTraderStrategy.mockResolvedValue({
      ...baseStrategy,
      sources: ['paper-1'],
    })
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({
        commit: { hash: 'abc12345' },
        pushed: { filled: [{ status: 'filled', orderId: 'ord-1', filledPrice: 100 }], pending: [], rejected: [] },
        commitDetails: { results: [{ status: 'filled', orderId: 'ord-1', filledPrice: 100 }] },
      })),
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount({ label: 'Paper Alpha' }))
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'source-1', symbol: 'BTC/USDT:USDT', reason: 'best setup on source-1' }],
        evaluations: buildCoverageEvaluations({
          source: 'source-1',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
          candidateReason: 'best setup on source-1',
        }),
        summary: 'one good candidate from source-1',
      }))
      .mockResolvedValueOnce(complete({
        status: 'thesis_ready',
        source: 'source-1',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'primary breakout continuation',
        alternateScenario: 'range failure',
        rationale: 'source-1 trend and pullback context align.',
        invalidation: ['loss of breakout level on source-1'],
        confidence: 0.74,
        contextNotes: ['Watch source-1 only.'],
      }))
      .mockResolvedValueOnce(complete({
        verdict: 'pass',
        source: 'source-1',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Risk budget is available on source-1.',
        maxRiskPercent: 0.5,
      }))
      .mockResolvedValueOnce(complete({
        status: 'plan_ready',
        source: 'source-1',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'primary breakout continuation',
        rationale: 'Trend and pullback context align on source-1.',
        invalidation: ['loss of breakout level on source-1'],
        commitMessage: 'momentum: source-1 breakout BTC/USDT:USDT',
        brainUpdate: 'Only execute on source-1.',
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
      .mockResolvedValueOnce(complete({
        status: 'execute',
        source: 'source-1',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Confirm execution on source-1.',
        brainUpdate: 'Execute only if source-1 still matches structure.',
      }))

    const result = await runTraderJob({
      jobId: 'job-user-facing-source',
      strategyId: 'momentum',
      session: { id: 'session-user-facing-source' } as SessionStore,
    }, deps)

    expect(result.status).toBe('done')
    expect(result.decision?.source).toBe('Paper Alpha')
    expect(result.reason).toBe('Confirm execution on Paper Alpha.')
    expect(result.reason).not.toContain('source-1')
    expect(result.rawText).not.toContain('source-1')
    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith(
      'Only execute on paper-1.\nExecute only if paper-1 still matches structure.',
    )
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
        evaluations: [
          { source: 'ccxt-main', symbol: 'BTC/USDT:USDT', verdict: 'candidate', reason: 'first setup' },
          { source: 'ccxt-main', symbol: 'ETH/USDT:USDT', verdict: 'candidate', reason: 'backup setup' },
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
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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
        evaluations: [
          ...buildCoverageEvaluations({
            source: 'ccxt-main',
            symbols: baseStrategy.universe.symbols,
          }),
          ...buildCoverageEvaluations({
            source: 'ccxt-hedge',
            symbols: baseStrategy.universe.symbols,
            candidateSymbol: 'BTC/USDT:USDT',
            candidateReason: 'hedge venue has the setup',
          }),
        ],
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
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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

  it('returns skip when deterministic execution rejects every order', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({
        commit: { hash: 'abc12345' },
        pushed: {
          filled: [],
          pending: [],
          rejected: [
            { status: 'rejected', orderId: 'ord-1', error: 'post only would cross' },
            { status: 'rejected', orderId: 'ord-2', error: 'insufficient margin' },
          ],
        },
        commitDetails: {
          results: [
            { status: 'rejected', orderId: 'ord-1', error: 'post only would cross' },
            { status: 'rejected', orderId: 'ord-2', error: 'insufficient margin' },
          ],
        },
      })),
    })

    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount({ positions: [] }))
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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
      jobId: 'job-all-rejected',
      strategyId: 'momentum',
      session: { id: 'session-all-rejected' } as SessionStore,
    }, deps)

    expect(result).toMatchObject({
      status: 'skip',
      reason: 'Execution failed: 2 order(s) were rejected.',
    })
    expect(result.decision).toBeUndefined()
    expect(result.rawText).toContain('insufficient margin')
  })

  it('returns skip when the thesis stage rejects the setup', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    deps.engine.askWithSession
      .mockResolvedValueOnce(complete({
        candidates: [{ source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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
        evaluations: buildCoverageEvaluations({
          source: 'ccxt-main',
          symbols: baseStrategy.universe.symbols,
          candidateSymbol: 'BTC/USDT:USDT',
        }),
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

  it('records ordered stage events with workflow state through execution', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({
        commit: { hash: 'abc12345' },
        pushed: { filled: [{ status: 'filled', orderId: 'ord-1', filledPrice: 101 }], pending: [], rejected: [] },
        commitDetails: { results: [{ status: 'filled', orderId: 'ord-1', filledPrice: 101 }] },
      })),
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    queueHappyPath(deps)

    const result = await runTraderJob({
      jobId: 'job-stage-events',
      strategyId: 'momentum',
      session: { id: 'session-stage-events' } as SessionStore,
      runId: 'run-stage-events',
      jobName: 'Stage Events',
    }, deps)

    expect(result.status).toBe('done')

    const stageEvents = deps.eventLog.append.mock.calls
      .filter(([type]) => type === 'trader.stage')
      .map(([, payload]) => payload)

    expect(stageEvents.map((payload: any) => `${payload.stage}:${payload.status}`)).toEqual([
      'market-scan:completed',
      'trade-thesis:completed',
      'risk-check:completed',
      'trade-plan:completed',
      'trade-execute:completed',
      'trade-execute-script:completed',
    ])
    expect(stageEvents.every((payload: any) => payload.runId === 'run-stage-events')).toBe(true)
    expect(stageEvents.every((payload: any) => payload.data.workflowState === payload.stage)).toBe(true)
    expect(stageEvents.map((payload: any) => payload.data.previousWorkflowState)).toEqual([
      'boot',
      'market-scan',
      'trade-thesis',
      'risk-check',
      'trade-plan',
      'trade-execute',
    ])
    expect(stageEvents.map((payload: any) => payload.data.nextAllowedStages)).toEqual([
      ['trade-thesis'],
      ['trade-thesis', 'risk-check'],
      ['trade-thesis', 'trade-plan'],
      ['trade-thesis', 'trade-execute'],
      ['trade-thesis', 'trade-execute-script'],
      [],
    ])
  })

  it('passes the previous workflow state into each stage-agent context', async () => {
    mocks.getTraderStrategy.mockResolvedValue(baseStrategy)
    mocks.getSkillScript.mockReturnValue({
      run: vi.fn(async () => ({
        commit: { hash: 'abc12345' },
        pushed: { filled: [{ status: 'filled', orderId: 'ord-1', filledPrice: 101 }], pending: [], rejected: [] },
        commitDetails: { results: [{ status: 'filled', orderId: 'ord-1', filledPrice: 101 }] },
      })),
    })
    const deps = makeDeps()
    deps.accountManager.getAccount.mockReturnValue(makeAccount())
    queueHappyPath(deps)

    await runTraderJob({
      jobId: 'job-stage-context',
      strategyId: 'momentum',
      session: { id: 'session-stage-context' } as SessionStore,
    }, deps)

    const skillContexts = deps.engine.askWithSession.mock.calls.map(([, , options]) => options.skillContext)
    expect(skillContexts.map((context: any) => context.stage)).toEqual([
      'market-scan',
      'trade-thesis',
      'risk-check',
      'trade-plan',
      'trade-execute',
    ])
    expect(skillContexts.map((context: any) => context.workflowState)).toEqual([
      'boot',
      'market-scan',
      'trade-thesis',
      'risk-check',
      'trade-plan',
    ])
  })
})

describe('runTraderReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates brain and writes a review event from the review skill result', async () => {
    const deps = makeDeps()
    deps.accountManager.listAccounts.mockReturnValue([{ id: 'paper-1' }])
    deps.accountManager.getAccount.mockReturnValue(makeAccount({ label: 'Paper Alpha' }))
    deps.engine.askWithSession.mockResolvedValue(complete({
      summary: 'Review summary for source-1',
      brainUpdate: 'Stay selective on source-1 and keep sizing small after mixed outcomes.',
    }))

    const result = await runTraderReview(undefined, deps, {
      trigger: 'scheduled',
      jobId: 'review-1',
      jobName: 'Nightly Review',
    })

    expect(deps.brain.updateFrontalLobe).toHaveBeenCalledWith(
      'Stay selective on Paper Alpha and keep sizing small after mixed outcomes.',
    )
    expect(deps.eventLog.append).toHaveBeenCalledWith('trader.review.done', {
      strategyId: undefined,
      trigger: 'scheduled',
      jobId: 'review-1',
      jobName: 'Nightly Review',
      updated: true,
      summary: 'Review summary for Paper Alpha',
      patchApplied: false,
      patchSummary: undefined,
      yamlDiff: undefined,
    })
    expect(result).toEqual({
      updated: true,
      summary: 'Review summary for Paper Alpha',
      strategyId: undefined,
      patchApplied: false,
      patchSummary: undefined,
      yamlDiff: undefined,
    })
  })

  it('applies a single-strategy behavior patch after review', async () => {
    const deps = makeDeps()
    mocks.getTraderStrategy.mockResolvedValueOnce({
      ...baseStrategy,
      sources: ['paper-1'],
    })
    deps.accountManager.getAccount.mockReturnValue(makeAccount({ label: 'Paper Alpha' }))
    deps.engine.askWithSession.mockResolvedValue(complete({
      summary: 'Review summary for source-1',
      brainUpdate: 'Stay selective on source-1.',
      strategyPatch: {
        behaviorRules: {
          preferences: ['Long only after a 5m close above 75471.03.'],
          prohibitions: ['Do not keep the breakout if price returns to 75134.8-75471.03 within 30 minutes.'],
        },
      },
      patchSummary: 'Refreshed breakout levels in behavior rules.',
    }))

    const result = await runTraderReview('momentum', deps)

    expect(mocks.applyTraderStrategyPatch).toHaveBeenCalledWith('momentum', {
      behaviorRules: {
        preferences: ['Long only after a 5m close above 75471.03.'],
        prohibitions: ['Do not keep the breakout if price returns to 75134.8-75471.03 within 30 minutes.'],
      },
    })
    expect(deps.eventLog.append).toHaveBeenCalledWith('trader.review.done', {
      strategyId: 'momentum',
      trigger: 'manual',
      jobId: undefined,
      jobName: undefined,
      updated: true,
      summary: 'Review summary for Paper Alpha',
      patchApplied: true,
      patchSummary: 'Refreshed breakout levels in behavior rules.',
      yamlDiff: '- behaviorRules:\n+ behaviorRules:',
    })
    expect(result).toEqual({
      updated: true,
      summary: 'Review summary for Paper Alpha',
      strategyId: 'momentum',
      patchApplied: true,
      patchSummary: 'Refreshed breakout levels in behavior rules.',
      yamlDiff: '- behaviorRules:\n+ behaviorRules:',
    })
  })
})
