import type {
  TraderMarketScanResult,
  TraderRiskCheckResult,
  TraderStrategy,
  TraderTradePlanResult,
  TraderTradeReviewSummary,
  TraderTradeThesisResult,
} from './types.js'

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

type TraderStage = 'market-scan' | 'trade-thesis' | 'risk-check' | 'trade-plan' | 'trade-execute' | 'trade-review'

export function buildStrategyCard(strategy: TraderStrategy, stage: TraderStage): string {
  switch (stage) {
    case 'market-scan':
      return [
        `Strategy: ${strategy.id} (${strategy.label})`,
        `Sources: ${strategy.sources.join(', ')}`,
        `Universe: ${strategy.universe.asset} — ${strategy.universe.symbols.join(', ')}`,
        `Timeframes: context=${strategy.timeframes.context}, structure=${strategy.timeframes.structure}, execution=${strategy.timeframes.execution}`,
        `Preferences: ${strategy.behaviorRules.preferences.join('; ') || '(none)'}`,
        `Avoid: ${strategy.behaviorRules.prohibitions.join('; ') || '(none)'}`,
      ].join('\n')
    case 'trade-thesis':
      return [
        `Strategy: ${strategy.id} (${strategy.label})`,
        `Focus symbol must come from configured universe: ${strategy.universe.symbols.join(', ')}`,
        `Timeframes: context=${strategy.timeframes.context}, structure=${strategy.timeframes.structure}, execution=${strategy.timeframes.execution}`,
        `Preferences: ${strategy.behaviorRules.preferences.join('; ') || '(none)'}`,
        `No-trade / avoid: ${strategy.behaviorRules.prohibitions.join('; ') || '(none)'}`,
      ].join('\n')
    case 'risk-check':
      return [
        `Strategy: ${strategy.id} (${strategy.label})`,
        `Per-trade risk: ${strategy.riskBudget.perTradeRiskPercent}%`,
        `Max gross exposure: ${strategy.riskBudget.maxGrossExposurePercent}%`,
        `Max positions: ${strategy.riskBudget.maxPositions}`,
        `Max daily loss: ${strategy.riskBudget.maxDailyLossPercent ?? 'n/a'}%`,
      ].join('\n')
    case 'trade-plan':
    case 'trade-execute':
      return [
        `Strategy: ${strategy.id} (${strategy.label})`,
        `Allowed order types: ${strategy.executionPolicy.allowedOrderTypes.join(', ')}`,
        `Require protection: ${strategy.executionPolicy.requireProtection ? 'yes' : 'no'}`,
        `Allow market orders: ${strategy.executionPolicy.allowMarketOrders ? 'yes' : 'no'}`,
        `Allow overnight: ${strategy.executionPolicy.allowOvernight ? 'yes' : 'no'}`,
      ].join('\n')
    case 'trade-review':
      return [
        `Strategy: ${strategy.id} (${strategy.label})`,
        `Universe: ${strategy.universe.symbols.join(', ')}`,
        `Review focus: ${strategy.behaviorRules.preferences.join('; ') || '(none)'}`,
        `Discipline watchlist: ${strategy.behaviorRules.prohibitions.join('; ') || '(none)'}`,
      ].join('\n')
  }
}

export function buildTraderSystemPrompt(strategy: TraderStrategy): string {
  return [
    `You are operating trader strategy "${strategy.id}" (${strategy.label}).`,
    'Follow the currently active stage skill, respect the provided strategy card, and respond with JSON only when the stage asks for structured output.',
  ].join('\n')
}

export function buildMarketScanPrompt(strategy: TraderStrategy, snapshot: TraderPreflightSnapshot): string {
  return [
    `Run the market-scan stage for strategy "${strategy.id}".`,
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'market-scan'),
    '',
    'Preflight snapshot:',
    JSON.stringify(snapshot, null, 2),
    '',
    'Goal: identify the best candidate symbols to study next. Use scripts, not OpenAlice tools.',
    'When you send the final complete envelope, its output field must match this shape exactly:',
    JSON.stringify({
      candidates: [{ source: strategy.sources[0] ?? 'source-id', symbol: strategy.universe.symbols[0] ?? 'BTC/USDT', reason: 'short reason' }],
      summary: 'short overview',
    } satisfies TraderMarketScanResult, null, 2),
  ].join('\n')
}

export function buildTradeThesisPrompt(strategy: TraderStrategy, candidate: { source: string; symbol: string }, snapshot: TraderPreflightSnapshot): string {
  return [
    `Run the trade-thesis stage for ${candidate.symbol} on source ${candidate.source}.`,
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'trade-thesis'),
    '',
    'Preflight snapshot:',
    JSON.stringify(snapshot, null, 2),
    '',
    'Goal: request whatever scripts you need, then produce a thesis for exactly one symbol.',
    'When you send the final complete envelope, its output field must match this shape exactly:',
    JSON.stringify({
      status: 'thesis_ready',
      source: candidate.source,
      symbol: candidate.symbol,
      bias: 'long',
      chosenScenario: 'primary',
      alternateScenario: 'alternate',
      rationale: 'short rationale',
      invalidation: ['one invalidation'],
      confidence: 0.5,
      contextNotes: ['optional note'],
    } satisfies TraderTradeThesisResult, null, 2),
  ].join('\n')
}

export function buildRiskCheckPrompt(strategy: TraderStrategy, thesis: TraderTradeThesisResult, snapshot: TraderPreflightSnapshot): string {
  return [
    `Run the risk-check stage for ${thesis.symbol} on source ${thesis.source}.`,
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'risk-check'),
    '',
    'Trade thesis:',
    JSON.stringify(thesis, null, 2),
    '',
    'Fresh account snapshot:',
    JSON.stringify(snapshot.sourceSnapshots.filter((entry) => entry.source === thesis.source), null, 2),
    '',
    'Goal: decide whether the thesis can proceed under current strategy limits.',
    'When you send the final complete envelope, its output field must match this shape exactly:',
    JSON.stringify({
      verdict: 'pass',
      source: thesis.source,
      symbol: thesis.symbol,
      rationale: 'risk budget is available',
      maxRiskPercent: strategy.riskBudget.perTradeRiskPercent,
    } satisfies TraderRiskCheckResult, null, 2),
  ].join('\n')
}

export function buildTradePlanPrompt(strategy: TraderStrategy, thesis: TraderTradeThesisResult, risk: TraderRiskCheckResult): string {
  return [
    `Run the trade-plan stage for ${thesis.symbol}.`,
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'trade-plan'),
    '',
    'Trade thesis:',
    JSON.stringify(thesis, null, 2),
    '',
    'Risk verdict:',
    JSON.stringify(risk, null, 2),
    '',
    'Goal: either skip or produce a deterministic execution plan. If status is plan_ready, include at least one staged order and a commit message. If status is skip, omit commitMessage and orders.',
    'When you send the final complete envelope, its output field must match one of these shapes exactly:',
    JSON.stringify({
      status: 'plan_ready',
      source: thesis.source,
      symbol: thesis.symbol,
      chosenScenario: thesis.chosenScenario,
      rationale: thesis.rationale,
      invalidation: thesis.invalidation,
      commitMessage: `${strategy.id}: ${thesis.chosenScenario} ${thesis.symbol}`,
      brainUpdate: 'short frontal-lobe update',
      orders: [],
    }, null, 2),
    JSON.stringify({
      status: 'skip',
      source: thesis.source,
      symbol: thesis.symbol,
      chosenScenario: thesis.chosenScenario,
      rationale: 'why execution must be skipped',
      invalidation: thesis.invalidation,
      brainUpdate: 'short frontal-lobe update',
    }, null, 2),
  ].join('\n')
}

export function buildTradeExecutePrompt(strategy: TraderStrategy, plan: TraderTradePlanResult): string {
  return [
    `Run the trade-execute confirmation stage for ${plan.symbol}.`,
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'trade-execute'),
    '',
    'Planned trade:',
    JSON.stringify(plan, null, 2),
    '',
    'Goal: confirm whether the deterministic execution plan should run exactly as written.',
    'When you send the final complete envelope, its output field must match this shape exactly:',
    JSON.stringify({
      status: 'execute',
      source: plan.source,
      symbol: plan.symbol,
      rationale: 'confirm execution',
      brainUpdate: plan.brainUpdate || 'executing approved trade plan',
    }, null, 2),
  ].join('\n')
}

export function buildTraderReviewPrompt(strategy: TraderStrategy | null, sources: string[]): string {
  return [
    strategy
      ? `Run the trade-review stage for strategy "${strategy.id}".`
      : 'Run the trade-review stage across all configured trader sources.',
    '',
    strategy ? `Strategy card:\n${buildStrategyCard(strategy, 'trade-review')}` : '',
    `Sources: ${sources.join(', ')}`,
    '',
    'Goal: summarize recent trading outcomes, highlight discipline wins/failures, and return a Brain update.',
    'When you send the final complete envelope, its output field must match this shape exactly:',
    JSON.stringify({
      summary: 'short review summary',
      brainUpdate: 'frontal lobe update text',
    } satisfies TraderTradeReviewSummary, null, 2),
  ].join('\n')
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
