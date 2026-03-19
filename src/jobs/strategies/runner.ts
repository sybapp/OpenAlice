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
import type { AccountInfo, MarketClock, Order, Position } from '../../domains/trading/interfaces.js'
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
  TraderMarketCandidate,
  TraderPlannedOrder,
  TraderReviewResult,
  TraderRunnerDeps,
  TraderRunnerResult,
  TraderStrategy,
  TraderTradePlanReadyResult,
} from './types.js'

const TRADER_SKILLS = {
  marketScan: 'trader-market-scan',
  tradeThesis: 'trader-trade-thesis',
  riskCheck: 'trader-risk-check',
  tradePlan: 'trader-trade-plan',
  tradeExecute: 'trader-trade-execute',
  tradeReview: 'trader-trade-review',
} as const

interface TraderSourceSnapshot {
  source: string
  account: AccountInfo | null
  positions: Position[]
  orders: Order[]
  marketClock?: MarketClock
}

interface TraderPreflightSnapshot {
  frontalLobe: string
  warnings: string[]
  exposurePercent: number
  totalPositions: number
  sourceSnapshots: TraderSourceSnapshot[]
}

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
    const wrappedText = parsed.text
    const output = parsed.type === 'complete' && 'output' in parsed
      ? parsed.output
      : wrappedText && typeof wrappedText === 'object' && (wrappedText as Record<string, unknown>).type === 'complete' && 'output' in (wrappedText as Record<string, unknown>)
        ? (wrappedText as Record<string, unknown>).output
        : parsed
    return schema.parse(output)
  } catch {
    return null
  }
}

async function buildPreflightSnapshot(strategy: TraderStrategy, deps: TraderRunnerDeps): Promise<TraderPreflightSnapshot> {
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

function summarizePlannedOrder(order: TraderPlannedOrder): string {
  const size = order.qty !== undefined
    ? `qty=${order.qty}`
    : order.notional !== undefined
      ? `notional=${order.notional}`
      : 'size=broker-default'
  const trigger = order.stopPrice !== undefined
    ? ` stop=${order.stopPrice}`
    : order.price !== undefined
      ? ` price=${order.price}`
      : ''
  const reduceOnly = order.reduceOnly ? ' reduceOnly' : ''
  const protection = order.protection
    ? ` | protection: SL ${order.protection.stopLossPrice ?? order.protection.stopLossPct ?? '-'} / TP ${order.protection.takeProfitPrice ?? order.protection.takeProfitPct ?? '-'}${order.protection.takeProfitSizeRatio !== undefined ? ` (ratio=${order.protection.takeProfitSizeRatio})` : ''}`
    : ''
  return `${order.side.toUpperCase()} ${order.type} ${order.symbol} ${size}${trigger}${reduceOnly}${protection}`.trim()
}

function getSourceSnapshot(snapshot: TraderPreflightSnapshot, source: string): TraderSourceSnapshot | undefined {
  return snapshot.sourceSnapshots.find((entry) => entry.source === source)
}

function getPositionKey(position: Position): string {
  return position.contract.symbol ?? position.contract.aliceId ?? ''
}

function estimateOrderExposurePercent(order: TraderPlannedOrder, sourceSnapshot: TraderSourceSnapshot | undefined): number | null {
  const equity = sourceSnapshot?.account?.equity ?? 0
  if (equity <= 0 || order.reduceOnly) return null

  const referencePrice = order.price
    ?? order.stopPrice
    ?? sourceSnapshot?.positions.find((position) => getPositionKey(position) === order.symbol)?.currentPrice
  const notional = order.notional ?? (order.qty !== undefined && referencePrice !== undefined ? order.qty * referencePrice : undefined)
  if (notional === undefined) return null

  return clampPercent(notional / equity * 100)
}

function getHardRiskBudgetViolation(
  strategy: TraderStrategy,
  snapshot: TraderPreflightSnapshot,
  plan: TraderTradePlanReadyResult,
): string | null {
  const additiveOrders = plan.orders.filter((order) => !order.reduceOnly)
  if (additiveOrders.length === 0) return null

  const sourceSnapshot = getSourceSnapshot(snapshot, plan.source)
  const heldSymbolsOnSource = new Set(
    (sourceSnapshot?.positions ?? []).map((position) => getPositionKey(position)).filter(Boolean),
  )
  const opensNewPosition = additiveOrders.some((order) => !heldSymbolsOnSource.has(order.symbol))

  if (opensNewPosition && snapshot.totalPositions >= strategy.riskBudget.maxPositions) {
    return `Hard risk gate blocked execution: current positions ${snapshot.totalPositions} already meet/exceed maxPositions ${strategy.riskBudget.maxPositions}.`
  }

  if (snapshot.exposurePercent >= strategy.riskBudget.maxGrossExposurePercent) {
    return `Hard risk gate blocked execution: current gross exposure ${snapshot.exposurePercent.toFixed(2)}% already meets/exceeds maxGrossExposurePercent ${strategy.riskBudget.maxGrossExposurePercent}%.`
  }

  const estimatedAddedExposure = additiveOrders.reduce((sum, order) => {
    const estimate = estimateOrderExposurePercent(order, sourceSnapshot)
    return sum + (estimate ?? 0)
  }, 0)

  if (estimatedAddedExposure > 0 && snapshot.exposurePercent + estimatedAddedExposure > strategy.riskBudget.maxGrossExposurePercent) {
    return `Hard risk gate blocked execution: projected gross exposure ${(snapshot.exposurePercent + estimatedAddedExposure).toFixed(2)}% would exceed maxGrossExposurePercent ${strategy.riskBudget.maxGrossExposurePercent}%.`
  }

  return null
}

function summarizeExecutionAction(order: TraderPlannedOrder, result: Record<string, unknown> | undefined): string {
  const summary = summarizePlannedOrder(order)
  if (!result) return `${summary} -> submitted`

  const status = typeof result.status === 'string' ? result.status : 'unknown'
  const orderId = typeof result.orderId === 'string' ? result.orderId : undefined
  const error = typeof result.error === 'string' ? result.error : undefined
  const filledPrice = typeof result.filledPrice === 'number' ? result.filledPrice : undefined

  if (status === 'filled') {
    return `${summary} -> filled${filledPrice !== undefined ? ` @${filledPrice}` : ''}${orderId ? ` (${orderId})` : ''}`
  }
  if (status === 'pending') {
    return `${summary} -> pending${orderId ? ` (${orderId})` : ''}`
  }
  if (status === 'rejected') {
    return `${summary} -> rejected${error ? `: ${error}` : ''}`
  }
  return `${summary} -> ${status}${orderId ? ` (${orderId})` : ''}`
}

function buildExecutionOutcome(plan: TraderTradePlanReadyResult, executionResult: unknown, fallbackRationale: string) {
  const executionRecord = executionResult as Record<string, unknown>
  const pushed = (executionRecord.pushed ?? {}) as Record<string, unknown>
  const commit = (executionRecord.commit ?? {}) as Record<string, unknown>
  const commitDetails = executionRecord.commitDetails as Record<string, unknown> | null | undefined
  const commitHash = typeof commit.hash === 'string' ? commit.hash : undefined
  const commitResults = Array.isArray(commitDetails?.results) ? commitDetails.results as Array<Record<string, unknown>> : []
  const filled = Array.isArray(pushed.filled) ? pushed.filled.length : 0
  const pending = Array.isArray(pushed.pending) ? pushed.pending.length : 0
  const rejected = Array.isArray(pushed.rejected) ? pushed.rejected.length : 0

  const rationale = rejected > 0
    ? filled === 0 && pending === 0
      ? `Execution failed: ${rejected} order(s) were rejected.`
      : `Execution completed with issues: ${filled} filled, ${pending} pending, ${rejected} rejected.`
    : pending > 0
      ? `Execution confirmed: ${filled} filled, ${pending} pending.`
      : fallbackRationale

  const actionsTaken = [
    `Executed deterministic trade plan: ${plan.commitMessage}${commitHash ? ` (${commitHash})` : ''}`,
    ...plan.orders.map((order, index) => summarizeExecutionAction(order, commitResults[index])),
  ]

  return {
    rationale,
    actionsTaken,
    rejectedCount: rejected,
  }
}

async function runCandidatePipeline(params: {
  strategy: TraderStrategy
  candidate: TraderMarketCandidate
  preflightSnapshot: TraderPreflightSnapshot
  session: SessionStore
  deps: TraderRunnerDeps
}) {
  const { strategy, candidate, preflightSnapshot, session, deps } = params

  const thesis = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.tradeThesis,
    prompt: buildTradeThesisPrompt(strategy, candidate, preflightSnapshot),
    schema: traderTradeThesisSchema,
    deps,
    skillContext: { strategy, candidate, snapshot: preflightSnapshot, stage: 'trade-thesis' },
  })

  if (thesis.output.status === 'no_trade') {
    updateBrainIfPresent(deps, ...thesis.output.contextNotes)
    return buildSkipResult(thesis.output.rationale, thesis.rawText)
  }

  // Risk review must use a fresh account snapshot because the earlier AI stages may take minutes.
  const riskSnapshot = await buildPreflightSnapshot(strategy, deps)
  if (riskSnapshot.warnings.some((warning) => warning.includes('not available'))) {
    return { fatal: buildSkipResult(riskSnapshot.warnings.join(' '), thesis.rawText) }
  }

  const risk = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.riskCheck,
    prompt: buildRiskCheckPrompt(strategy, thesis.output, riskSnapshot),
    schema: traderRiskCheckSchema,
    deps,
    skillContext: { strategy, thesis: thesis.output, snapshot: riskSnapshot, stage: 'risk-check' },
  })

  if (risk.output.verdict !== 'pass') {
    return buildSkipResult(risk.output.rationale, risk.rawText)
  }

  const plan = await runSkillStage({
    session,
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

  const hardRiskBlock = getHardRiskBudgetViolation(strategy, riskSnapshot, plan.output)
  if (hardRiskBlock) {
    updateBrainIfPresent(deps, plan.output.brainUpdate)
    return buildSkipResult(hardRiskBlock, plan.rawText)
  }

  const execute = await runSkillStage({
    session,
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

  const brainUpdate = updateBrainIfPresent(deps, plan.output.brainUpdate, execute.output.brainUpdate)

  const executionResult = await executeScript.run({
    config: deps.config,
    eventLog: deps.eventLog,
    brain: deps.brain,
    accountManager: deps.accountManager,
    marketData: deps.marketData,
    ohlcvStore: deps.ohlcvStore,
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

  const executionOutcome = buildExecutionOutcome(plan.output, executionResult, execute.output.rationale)
  const decision: TraderDecision = {
    status: 'trade',
    strategyId: strategy.id,
    source: plan.output.source,
    symbol: plan.output.symbol,
    chosenScenario: plan.output.chosenScenario,
    rationale: executionOutcome.rationale,
    invalidation: plan.output.invalidation,
    actionsTaken: executionOutcome.actionsTaken,
    brainUpdate,
  }

  return {
    status: 'done' as const,
    reason: decision.rationale,
    decision,
    rawText: JSON.stringify(executionResult, null, 2),
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

  if (scan.output.candidates.length === 0) {
    return {
      status: 'skip',
      reason: scan.output.summary || 'No tradable candidate found.',
      rawText: scan.rawText,
    }
  }

  let lastSkip: TraderRunnerResult = {
    status: 'skip',
    reason: scan.output.summary || 'No tradable candidate survived the pipeline.',
    rawText: scan.rawText,
  }

  for (const candidate of scan.output.candidates) {
    const result = await runCandidatePipeline({
      strategy,
      candidate,
      preflightSnapshot: snapshot,
      session: params.session,
      deps,
    })

    if ('fatal' in result) {
      return result.fatal
    }
    if (result.status === 'done') {
      return result
    }
    lastSkip = result
  }

  return lastSkip
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
