import { describe, expect, it } from 'vitest'
import {
  createTraderWorkflowAgentStageDefinitions,
  interpretTraderWorkflowStageTransitions,
  resolveTradeExecuteScriptRoute,
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

  it('marks all-rejected execution scripts as a terminal stop', () => {
    const route = resolveTradeExecuteScriptRoute({
      source: 'ccxt-main',
      symbol: 'BTC/USDT:USDT',
      commitMessage: 'momentum: breakout BTC/USDT:USDT',
      executionOutcome: {
        rationale: 'Execution failed: 1 order(s) were rejected.',
        filledCount: 0,
        pendingCount: 0,
        rejectedCount: 1,
      },
      executionResult: { pushed: { rejected: [{ status: 'rejected' }] } },
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
})
