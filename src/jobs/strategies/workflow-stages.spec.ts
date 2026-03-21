import { describe, expect, it } from 'vitest'
import {
  buildTradeExecutionOutcome,
  buildTradeExecutionRunnerResult,
  createTraderWorkflowAgentStageDefinitions,
  interpretTraderWorkflowStageTransitions,
  resolveRiskSnapshotFailureRouteForWarnings,
  resolveTraderWorkflowStageRoute,
} from './workflow-stages.js'

const strategy = {
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
} as const

function makeStages() {
  return createTraderWorkflowAgentStageDefinitions({
    strategy: { ...strategy },
    publicStrategy: { ...strategy },
    toPublicSnapshot: (snapshot) => snapshot,
    toPublicSource: (value) => value,
    toInternalSource: (value) => value,
    replaceInternalStrings: (value) => value,
  })
}

describe('trader workflow stage transitions', () => {
  it('routes empty market scans to a terminal skip', () => {
    const stages = makeStages()
    const definition = stages.marketScan({
      frontalLobe: '',
      warnings: [],
      exposurePercent: 0,
      totalPositions: 0,
      sourceSnapshots: [],
    })

    const route = resolveTraderWorkflowStageRoute(definition, {
      output: {
        candidates: [],
        evaluations: [{
          source: 'ccxt-main',
          symbol: 'BTC/USDT:USDT',
          verdict: 'skip',
          reason: 'No clean setup.',
        }],
        summary: '',
      },
      rawText: 'raw scan',
      eventData: { summary: '' },
    })

    expect(route).toMatchObject({
      status: 'skipped',
      decision: 'stop-run',
      runnerResult: {
        status: 'skip',
        reason: 'BTC/USDT:USDT on ccxt-main: No clean setup.',
        rawText: 'raw scan',
      },
    })
  })

  it('routes trade thesis no-trade outcomes to the next candidate', () => {
    const stages = makeStages()
    const definition = stages.tradeThesis(
      { source: 'ccxt-main', symbol: 'BTC/USDT:USDT', reason: 'range' },
      { frontalLobe: '', warnings: [], exposurePercent: 0, totalPositions: 0, sourceSnapshots: [] },
    )

    const route = interpretTraderWorkflowStageTransitions(
      definition.stage,
      {
        status: 'no_trade',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'flat',
        chosenScenario: 'stand aside',
        rationale: 'No clean entry.',
        invalidation: ['n/a'],
        confidence: 0.2,
        contextNotes: ['Stay patient.'],
      },
      {
        rawText: 'raw thesis',
        eventData: { source: 'ccxt-main', symbol: 'BTC/USDT:USDT' },
      },
      definition.transitions ?? [],
    )

    expect(route).toMatchObject({
      status: 'skipped',
      decision: 'next-candidate',
      runnerResult: {
        status: 'skip',
        reason: 'No clean entry.',
        rawText: 'raw thesis',
      },
      brainUpdates: ['Stay patient.'],
    })
  })

  it('routes trade execute abort outcomes to the next candidate', () => {
    const stages = makeStages()
    const definition = stages.tradeExecute({
      status: 'plan_ready',
      source: 'ccxt-main',
      symbol: 'BTC/USDT:USDT',
      chosenScenario: 'breakout',
      rationale: 'Structured plan.',
      invalidation: ['lost level'],
      brainUpdate: 'Wait for confirmation.',
      commitMessage: 'momentum: breakout BTC/USDT:USDT',
      orders: [{ aliceId: 'btc-1', symbol: 'BTC/USDT:USDT', side: 'buy', type: 'stop', qty: 1, stopPrice: 100, timeInForce: 'day' }],
    })

    const route = interpretTraderWorkflowStageTransitions(
      definition.stage,
      {
        status: 'abort',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Exchange window closed.',
        brainUpdate: 'Wait for reopen.',
      },
      {
        rawText: 'raw execute',
        eventData: { source: 'ccxt-main', symbol: 'BTC/USDT:USDT' },
      },
      definition.transitions ?? [],
    )

    expect(route).toMatchObject({
      status: 'skipped',
      decision: 'next-candidate',
      runnerResult: {
        status: 'skip',
        reason: 'Exchange window closed.',
        rawText: 'raw execute',
      },
      brainUpdates: ['Wait for reopen.'],
    })
  })

  it('routes hard-risk plan overrides to the next candidate', () => {
    const stages = makeStages()
    const definition = stages.tradePlan(
      {
        status: 'thesis_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'breakout',
        alternateScenario: 'range failure',
        rationale: 'Trend is aligned.',
        invalidation: ['lost level'],
        confidence: 0.74,
        contextNotes: [],
      },
      {
        verdict: 'pass',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        rationale: 'Budget available.',
        maxRiskPercent: 0.5,
      },
    )

    const route = resolveTraderWorkflowStageRoute(definition, {
      output: {
        status: 'plan_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'breakout',
        rationale: 'Structured plan.',
        invalidation: ['lost level'],
        brainUpdate: 'Do not overtrade a full book.',
        commitMessage: 'momentum: breakout BTC/USDT:USDT',
        orders: [{ aliceId: 'btc-1', symbol: 'BTC/USDT:USDT', side: 'buy', type: 'stop', qty: 1, stopPrice: 100, timeInForce: 'day' }],
      },
      rawText: 'raw plan',
      eventData: { source: 'ccxt-main', symbol: 'BTC/USDT:USDT' },
      runtime: {
        hardRiskBlock: 'Hard risk gate blocked execution: current positions 1 already meet/exceed maxPositions 1.',
      },
    })

    expect(route).toMatchObject({
      status: 'skipped',
      decision: 'next-candidate',
      runnerResult: {
        status: 'skip',
        reason: 'Hard risk gate blocked execution: current positions 1 already meet/exceed maxPositions 1.',
        rawText: 'raw plan',
      },
      brainUpdates: ['Do not overtrade a full book.'],
      eventData: {
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        gate: 'hard-risk-budget',
      },
    })
  })

  it('marks all-rejected execution scripts as a terminal stop', () => {
    const stages = makeStages()
    const definition = stages.tradeExecuteScript()

    const route = resolveTraderWorkflowStageRoute(definition, {
      output: {
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        commitMessage: 'momentum: breakout BTC/USDT:USDT',
        outcome: {
          rationale: 'Execution failed: 1 order(s) were rejected.',
          filledCount: 0,
          pendingCount: 0,
          rejectedCount: 1,
        },
        result: { pushed: { rejected: [{ status: 'rejected' }] } },
      },
      eventData: {
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        commitMessage: 'momentum: breakout BTC/USDT:USDT',
        outcome: {
          rationale: 'Execution failed: 1 order(s) were rejected.',
          filledCount: 0,
          pendingCount: 0,
          rejectedCount: 1,
        },
        result: { pushed: { rejected: [{ status: 'rejected' }] } },
      },
      rawText: '{"pushed":{"rejected":[{"status":"rejected"}]}}',
    })

    expect(route).toMatchObject({
      status: 'skipped',
      decision: 'stop-run',
      completeWorkflow: true,
      runnerResult: {
        status: 'skip',
        reason: 'Execution failed: 1 order(s) were rejected.',
      },
    })
  })

  it('builds a risk snapshot failure route only when source availability warnings exist', () => {
    const thesis = {
      status: 'thesis_ready',
      source: 'ccxt-main',
      symbol: 'BTC/USDT:USDT',
      bias: 'long',
      chosenScenario: 'breakout',
      alternateScenario: 'range failure',
      rationale: 'Trend is aligned.',
      invalidation: ['lost level'],
      confidence: 0.74,
      contextNotes: [],
    } as const

    expect(resolveRiskSnapshotFailureRouteForWarnings(
      thesis,
      { frontalLobe: '', warnings: ['Clock drift warning only'], exposurePercent: 0, totalPositions: 0, sourceSnapshots: [] },
      'raw thesis',
    )).toBeNull()

    expect(resolveRiskSnapshotFailureRouteForWarnings(
      thesis,
      { frontalLobe: '', warnings: ['Configured source not available: ccxt-main'], exposurePercent: 0, totalPositions: 0, sourceSnapshots: [] },
      'raw thesis',
    )).toMatchObject({
      status: 'failed',
      decision: 'stop-run',
      runnerResult: {
        status: 'skip',
        reason: 'Configured source not available: ccxt-main',
        rawText: 'raw thesis',
      },
    })
  })

  it('builds the final trade runner result from execution outcome', () => {
    const outcome = buildTradeExecutionOutcome({
      status: 'plan_ready',
      source: 'ccxt-main',
      symbol: 'BTC/USDT:USDT',
      chosenScenario: 'breakout',
      rationale: 'Structured plan.',
      invalidation: ['lost level'],
      brainUpdate: 'Stay disciplined.',
      commitMessage: 'momentum: breakout BTC/USDT:USDT',
      orders: [{ aliceId: 'btc-1', symbol: 'BTC/USDT:USDT', side: 'buy', type: 'stop', qty: 1, stopPrice: 100, timeInForce: 'day' }],
    }, {
      commit: { hash: 'abc12345' },
      pushed: { filled: [{ status: 'filled', orderId: 'ord-1', filledPrice: 100 }], pending: [], rejected: [] },
      commitDetails: { results: [{ status: 'filled', orderId: 'ord-1', filledPrice: 100 }] },
    }, 'Confirm execution.')

    const result = buildTradeExecutionRunnerResult({
      strategyId: 'momentum',
      plan: {
        status: 'plan_ready',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'breakout',
        rationale: 'Structured plan.',
        invalidation: ['lost level'],
        brainUpdate: 'Stay disciplined.',
        commitMessage: 'momentum: breakout BTC/USDT:USDT',
        orders: [{ aliceId: 'btc-1', symbol: 'BTC/USDT:USDT', side: 'buy', type: 'stop', qty: 1, stopPrice: 100, timeInForce: 'day' }],
      },
      outcome,
      brainUpdate: 'Execute if structure holds.',
      rawText: '{"commit":{"hash":"abc12345"}}',
    })

    expect(result).toMatchObject({
      status: 'done',
      reason: 'Confirm execution.',
      decision: {
        status: 'trade',
        strategyId: 'momentum',
        source: 'ccxt-main',
        symbol: 'BTC/USDT:USDT',
        chosenScenario: 'breakout',
        rationale: 'Confirm execution.',
        brainUpdate: 'Execute if structure holds.',
      },
      rawText: '{"commit":{"hash":"abc12345"}}',
    })
    expect(result.decision?.actionsTaken).toEqual([
      'Executed deterministic trade plan: momentum: breakout BTC/USDT:USDT (abc12345)',
      'BUY stop BTC/USDT:USDT qty=1 stop=100 -> filled @100 (ord-1)',
    ])
  })
})
