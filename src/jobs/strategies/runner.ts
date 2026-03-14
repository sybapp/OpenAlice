import type { SessionStore } from '../../core/session.js'
import { setSessionSkill } from '../../skills/session-skill.js'
import {
  traderMarketScanSchema,
  traderRiskCheckSchema,
  traderTradeExecuteSchema,
  traderTradePlanSchema,
  traderTradeReviewSchema,
  traderTradeThesisSchema,
} from '../../skills/completion-schemas.js'
import { getSkillScript } from '../../skills/script-registry.js'
import { computeTradingStats } from '../../domains/trading/stats.js'
import {
  buildMarketScanPrompt,
  buildRiskCheckPrompt,
  buildTradeExecutePrompt,
  buildTradePlanPrompt,
  buildTraderReviewPrompt,
  buildTradeThesisPrompt,
} from './prompt.js'
import { getTraderStrategy } from './strategy.js'
import type {
  TraderDecision,
  TraderReviewResult,
  TraderRunnerDeps,
  TraderRunnerResult,
  TraderStrategy,
} from './types.js'

const TRADER_SKILLS = {
  marketScan: 'trader-market-scan',
  tradeThesis: 'trader-trade-thesis',
  riskCheck: 'trader-risk-check',
  tradePlan: 'trader-trade-plan',
  tradeExecute: 'trader-trade-execute',
  tradeReview: 'trader-trade-review',
} as const

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, value)) : 0
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence?.[1]) return fence[1].trim()

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

function parseStageOutput<T>(text: string, schema: { parse: (value: unknown) => T }): T | null {
  const candidate = extractJsonObject(text)
  if (!candidate) return null

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const output = parsed.type === 'complete' && 'output' in parsed ? parsed.output : parsed
    return schema.parse(output)
  } catch {
    return null
  }
}

async function buildPreflightSnapshot(strategy: TraderStrategy, deps: TraderRunnerDeps) {
  const frontalLobe = deps.brain.getFrontalLobe()
  const warnings: string[] = []
  let totalExposurePercent = 0
  let totalPositions = 0

  const sourceSnapshots = await Promise.all(strategy.sources.map(async (source) => {
    const account = deps.accountManager.getAccount(source)
    if (!account) {
      warnings.push(`Configured source not available: ${source}`)
      return {
        source,
        account: null,
        positions: [],
        orders: [],
      }
    }

    const [accountInfo, positions, orders, marketClock] = await Promise.all([
      account.getAccount(),
      account.getPositions(),
      account.getOrders(),
      account.getMarketClock().catch(() => undefined),
    ])

    const grossExposure = accountInfo.equity > 0
      ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0) / accountInfo.equity * 100
      : 0

    totalExposurePercent += grossExposure
    totalPositions += positions.length

    return {
      source,
      account: accountInfo,
      positions,
      orders,
      marketClock,
    }
  }))

  if (totalPositions >= strategy.riskBudget.maxPositions) {
    warnings.push(`Current positions ${totalPositions} already meet/exceed maxPositions ${strategy.riskBudget.maxPositions}.`)
  }
  if (totalExposurePercent >= strategy.riskBudget.maxGrossExposurePercent) {
    warnings.push(`Current gross exposure ${totalExposurePercent.toFixed(2)}% meets/exceeds maxGrossExposurePercent ${strategy.riskBudget.maxGrossExposurePercent}%.`)
  }
  if (strategy.universe.asset === 'equity') {
    const anyOpen = sourceSnapshots.some((snapshot) => {
      const clock = snapshot.marketClock as { isOpen?: boolean } | undefined
      return clock?.isOpen === true
    })
    if (!anyOpen) {
      warnings.push('No configured equity source currently reports an open market clock.')
    }
  }

  return {
    frontalLobe,
    warnings,
    exposurePercent: clampPercent(totalExposurePercent),
    totalPositions,
    sourceSnapshots,
  }
}

async function runSkillStage<T>(params: {
  session: SessionStore
  skillId: string
  prompt: string
  schema: { parse: (value: unknown) => T }
  deps: TraderRunnerDeps
  skillContext?: Record<string, unknown>
}) {
  await setSessionSkill(params.session, params.skillId)
  const result = await params.deps.engine.askWithSession(params.prompt, params.session, {
    historyPreamble: 'The following is the prior structured skill-loop history for this trader session.',
    maxHistoryEntries: 30,
    skillContext: params.skillContext,
  })
  const output = parseStageOutput(result.text, params.schema)
  if (!output) {
    throw new Error(`Skill ${params.skillId} did not return a valid completion payload`)
  }
  return { output, rawText: result.text }
}

function combineBrainUpdates(...updates: Array<string | undefined>): string {
  return updates.filter(Boolean).join('\n')
}

function updateBrainIfPresent(deps: TraderRunnerDeps, ...updates: Array<string | undefined>) {
  const combined = combineBrainUpdates(...updates)
  if (combined) {
    deps.brain.updateFrontalLobe(combined)
  }
  return combined
}

function buildSkipResult(reason: string, rawText: string): TraderRunnerResult {
  return {
    status: 'skip',
    reason,
    rawText,
  }
}

export async function runTraderJob(
  params: { jobId: string; strategyId: string; session: SessionStore },
  deps: TraderRunnerDeps,
): Promise<TraderRunnerResult> {
  const strategy = await getTraderStrategy(params.strategyId)
  if (!strategy) {
    return { status: 'skip', reason: `Unknown strategy: ${params.strategyId}` }
  }
  if (!strategy.enabled) {
    return { status: 'skip', reason: `Strategy ${strategy.id} is disabled` }
  }

  const snapshot = await buildPreflightSnapshot(strategy, deps)
  if (snapshot.warnings.some((warning) => warning.includes('not available'))) {
    return { status: 'skip', reason: snapshot.warnings.join(' ') }
  }

  const scan = await runSkillStage({
    session: params.session,
    skillId: TRADER_SKILLS.marketScan,
    prompt: buildMarketScanPrompt(strategy, snapshot),
    schema: traderMarketScanSchema,
    deps,
    skillContext: { strategy, snapshot, stage: 'market-scan' },
  })

  const candidate = scan.output.candidates[0]
  if (!candidate) {
    return {
      status: 'skip',
      reason: scan.output.summary || 'No tradable candidate found.',
      rawText: scan.rawText,
    }
  }

  const thesis = await runSkillStage({
    session: params.session,
    skillId: TRADER_SKILLS.tradeThesis,
    prompt: buildTradeThesisPrompt(strategy, candidate, snapshot),
    schema: traderTradeThesisSchema,
    deps,
    skillContext: { strategy, candidate, snapshot, stage: 'trade-thesis' },
  })

  if (thesis.output.status === 'no_trade') {
    updateBrainIfPresent(deps, ...thesis.output.contextNotes)
    return buildSkipResult(thesis.output.rationale, thesis.rawText)
  }

  const risk = await runSkillStage({
    session: params.session,
    skillId: TRADER_SKILLS.riskCheck,
    prompt: buildRiskCheckPrompt(strategy, thesis.output, snapshot),
    schema: traderRiskCheckSchema,
    deps,
    skillContext: { strategy, thesis: thesis.output, snapshot, stage: 'risk-check' },
  })

  if (risk.output.verdict !== 'pass') {
    return buildSkipResult(risk.output.rationale, risk.rawText)
  }

  const plan = await runSkillStage({
    session: params.session,
    skillId: TRADER_SKILLS.tradePlan,
    prompt: buildTradePlanPrompt(strategy, thesis.output, risk.output),
    schema: traderTradePlanSchema,
    deps,
    skillContext: { strategy, thesis: thesis.output, risk: risk.output, stage: 'trade-plan' },
  })

  if (plan.output.status !== 'plan_ready' || plan.output.orders.length === 0) {
    updateBrainIfPresent(deps, plan.output.brainUpdate)
    return buildSkipResult(plan.output.rationale, plan.rawText)
  }

  const execute = await runSkillStage({
    session: params.session,
    skillId: TRADER_SKILLS.tradeExecute,
    prompt: buildTradeExecutePrompt(strategy, plan.output),
    schema: traderTradeExecuteSchema,
    deps,
    skillContext: { strategy, plan: plan.output, stage: 'trade-execute' },
  })

  if (execute.output.status !== 'execute') {
    updateBrainIfPresent(deps, execute.output.brainUpdate)
    return buildSkipResult(execute.output.rationale, execute.rawText)
  }

  const executeScript = getSkillScript('trader-execute-plan')
  if (!executeScript) {
    throw new Error('Missing trader-execute-plan script')
  }
  const executionResult = await executeScript.run({
    config: deps.config,
    eventLog: deps.eventLog,
    brain: deps.brain,
    accountManager: deps.accountManager,
    marketData: deps.marketData,
    symbolIndex: deps.symbolIndex,
    ohlcvStore: deps.ohlcvStore,
    equityClient: deps.equityClient,
    cryptoClient: deps.cryptoClient,
    currencyClient: deps.currencyClient,
    newsClient: deps.newsClient,
    newsStore: deps.newsStore,
    getAccountGit: deps.getAccountGit,
    invocation: {
      strategy,
      plan: plan.output,
      stage: 'trade-execute-script',
    },
  }, {
    source: plan.output.source,
    commitMessage: plan.output.commitMessage,
    orders: plan.output.orders,
  })

  const brainUpdate = updateBrainIfPresent(deps, plan.output.brainUpdate, execute.output.brainUpdate)

  const decision: TraderDecision = {
    status: 'trade',
    strategyId: strategy.id,
    source: plan.output.source,
    symbol: plan.output.symbol,
    chosenScenario: plan.output.chosenScenario,
    rationale: execute.output.rationale,
    invalidation: plan.output.invalidation,
    actionsTaken: [`Executed deterministic trade plan: ${plan.output.commitMessage}`],
    brainUpdate,
  }

  return {
    status: 'done',
    reason: decision.rationale,
    decision,
    rawText: JSON.stringify(executionResult, null, 2),
  }
}

export async function runTraderReview(
  strategyId: string | undefined,
  deps: TraderRunnerDeps,
  meta?: { trigger?: 'manual' | 'scheduled'; jobId?: string; jobName?: string },
): Promise<TraderReviewResult> {
  const strategy = strategyId ? await getTraderStrategy(strategyId) : null
  const sources = strategy?.sources ?? deps.accountManager.listAccounts().map((account) => account.id)
  const session = {
    id: `trader-review/${strategyId ?? 'all'}`,
    appendUser: async () => undefined,
    appendAssistant: async () => undefined,
    appendSystem: async () => undefined,
    appendRaw: async () => undefined,
    readAll: async () => [],
    readActive: async () => [],
    restore: async () => {},
    exists: async () => false,
  } as unknown as SessionStore

  const review = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.tradeReview,
    prompt: buildTraderReviewPrompt(strategy, sources),
    schema: traderTradeReviewSchema,
    deps: deps as TraderRunnerDeps,
    skillContext: { strategy, sources, stage: 'trade-review' },
  })

  deps.brain.updateFrontalLobe(review.output.brainUpdate)
  await deps.eventLog.append('trader.review.done', {
    strategyId,
    trigger: meta?.trigger ?? 'manual',
    jobId: meta?.jobId,
    jobName: meta?.jobName,
    updated: true,
    summary: review.output.summary,
  })
  return {
    updated: true,
    summary: review.output.summary,
    strategyId,
  }
}
