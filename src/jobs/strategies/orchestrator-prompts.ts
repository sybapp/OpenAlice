import type {
  TraderMarketCandidate,
  TraderRiskCheckResult,
  TraderStrategy,
  TraderTradePlanResult,
  TraderTradeThesisResult,
} from './types.js'

interface TraderSourceSnapshot {
  source: string
  account: unknown
  positions: unknown[]
  orders: unknown[]
  marketClock?: unknown
}

interface TraderPreflightSnapshot {
  frontalLobe: string
  warnings: string[]
  exposurePercent: number
  totalPositions: number
  sourceSnapshots: TraderSourceSnapshot[]
}

function buildStrategyCard(strategy: TraderStrategy, stage: string): string {
  return JSON.stringify({
    id: strategy.id,
    label: strategy.label,
    stage,
    sources: strategy.sources,
    universe: strategy.universe,
    timeframes: strategy.timeframes,
    riskBudget: strategy.riskBudget,
    behaviorRules: strategy.behaviorRules,
    executionPolicy: strategy.executionPolicy,
  }, null, 2)
}

export function buildMarketScanTask(strategy: TraderStrategy, snapshot: TraderPreflightSnapshot): string {
  return [
    `Run the market-scan stage for strategy "${strategy.id}".`,
    '',
    'Use the invocation context and requested scripts as your evidence ledger.',
    'Do not finish until every configured symbol has an explicit evaluation and you have checked each configured source account state.',
    'Return a short ranked candidate list plus explicit evaluations for the full configured coverage set.',
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'market-scan'),
    '',
    'Preflight snapshot:',
    JSON.stringify(snapshot, null, 2),
  ].join('\n')
}

export function buildTradeThesisTask(
  strategy: TraderStrategy,
  candidate: TraderMarketCandidate,
  snapshot: TraderPreflightSnapshot,
): string {
  return [
    `Run the trade-thesis stage for ${candidate.symbol} on source ${candidate.source}.`,
    '',
    'Use the invocation context plus any requested scripts to build one constrained thesis for exactly this candidate.',
    'If structure or catalyst evidence is mixed, prefer `no_trade`.',
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'trade-thesis'),
    '',
    'Candidate:',
    JSON.stringify(candidate, null, 2),
    '',
    'Preflight snapshot:',
    JSON.stringify(snapshot, null, 2),
  ].join('\n')
}

export function buildRiskCheckTask(
  strategy: TraderStrategy,
  thesis: TraderTradeThesisResult,
  snapshot: TraderPreflightSnapshot,
): string {
  return [
    `Run the risk-check stage for ${thesis.symbol} on source ${thesis.source}.`,
    '',
    'Use the fresh account snapshot in the invocation context before deciding.',
    'Keep deterministic business limits in mind and return pass, fail, or reduce only for this thesis.',
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'risk-check'),
    '',
    'Trade thesis:',
    JSON.stringify(thesis, null, 2),
    '',
    'Fresh snapshot:',
    JSON.stringify(snapshot.sourceSnapshots.filter((entry) => entry.source === thesis.source), null, 2),
  ].join('\n')
}

export function buildTradePlanTask(
  strategy: TraderStrategy,
  thesis: TraderTradeThesisResult,
  risk: TraderRiskCheckResult,
): string {
  return [
    `Run the trade-plan stage for ${thesis.symbol}.`,
    '',
    'Translate the approved thesis into a deterministic plan or skip.',
    'If status is `plan_ready`, include at least one concrete order and a commit message.',
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'trade-plan'),
    '',
    'Trade thesis:',
    JSON.stringify(thesis, null, 2),
    '',
    'Risk verdict:',
    JSON.stringify(risk, null, 2),
  ].join('\n')
}

export function buildTradeExecuteTask(strategy: TraderStrategy, plan: TraderTradePlanResult): string {
  return [
    `Run the trade-execute confirmation stage for ${plan.symbol}.`,
    '',
    'This stage only confirms or aborts the deterministic plan exactly as written.',
    'Do not invent new orders or modify the order list.',
    '',
    'Strategy card:',
    buildStrategyCard(strategy, 'trade-execute'),
    '',
    'Planned trade:',
    JSON.stringify(plan, null, 2),
  ].join('\n')
}
