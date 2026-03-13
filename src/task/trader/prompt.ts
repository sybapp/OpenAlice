import type { TraderDecision, TraderStrategy } from './types.js'

interface TraderPreflightSnapshot {
  frontalLobe: string
  warnings: string[]
  exposurePercent: number
  totalPositions: number
  sourceSnapshots: Array<{
    source: string
    account: unknown
    positions: unknown[]
    orders: unknown[]
    marketClock?: unknown
  }>
}

export function buildTraderSystemPrompt(strategy: TraderStrategy): string {
  return [
    `You are running the trader-auto execution skill for strategy "${strategy.id}" (${strategy.label}).`,
    'Your job is to read structured market-analysis tools, decide whether to trade, and if justified execute the full trading git workflow in the same round.',
    '',
    'Execution contract:',
    '- Always use exact account ids from the strategy sources.',
    '- Always call getAccount, getPortfolio, getOrders, tradingStatus, and tradingLog before any new trade.',
    '- Use brooksPaAnalyze and ictSmcAnalyze with detailLevel="core" and dropUnclosed=true.',
    '- Respect the strategy risk budget and execution policy exactly.',
    '- If you trade, complete stage -> tradingCommit -> tradingPush in the same round.',
    '- tradingCommit message must include strategy id, chosen scenario, symbol, and invalidation.',
    '- End with JSON only using the TraderDecision schema provided in the user prompt.',
  ].join('\n')
}

export function buildTraderPrompt(strategy: TraderStrategy, snapshot: TraderPreflightSnapshot): string {
  return [
    `Run the automated trader loop for strategy "${strategy.id}".`,
    '',
    'Strategy:',
    JSON.stringify(strategy, null, 2),
    '',
    'Preflight snapshot:',
    JSON.stringify(snapshot, null, 2),
    '',
    'Process:',
    `1. Read account state using the exact sources: ${strategy.sources.join(', ')}.`,
    `2. Analyze the universe symbols: ${strategy.universe.symbols.join(', ')}.`,
    `3. Use Brooks timeframes ${strategy.timeframes.context}/${strategy.timeframes.structure}/${strategy.timeframes.execution}.`,
    `4. Use ICT/SMC on timeframe ${strategy.timeframes.structure}.`,
    '5. If no clean setup exists or risk budget is exhausted, do not trade.',
    '6. If a trade is justified, execute it and write a commit message that includes scenario + invalidation.',
    '7. Finish with JSON only matching this shape:',
    JSON.stringify(exampleDecision(strategy.id), null, 2),
  ].join('\n')
}

function exampleDecision(strategyId: string): TraderDecision {
  return {
    status: 'skip',
    strategyId,
    source: 'ccxt-main',
    symbol: 'BTC/USDT:USDT',
    chosenScenario: 'primary',
    rationale: 'Structure is mixed and no clean trigger is present.',
    invalidation: ['Break and hold above the latest execution resistance.'],
    actionsTaken: ['No trade executed.'],
    brainUpdate: 'Stayed flat. Bias is mixed; wait for clearer structure and a stronger trigger.',
  }
}

export function buildTraderReviewSummary(input: {
  strategyId?: string
  summaries: Array<{ source: string; summary: string }>
}): string {
  const header = input.strategyId
    ? `Trader review for strategy ${input.strategyId}`
    : 'Trader review across active strategies'
  return [
    header,
    '',
    ...input.summaries.map((entry) => `- ${entry.source}: ${entry.summary}`),
  ].join('\n')
}
