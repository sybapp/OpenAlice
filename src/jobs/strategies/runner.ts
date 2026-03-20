import type { SessionStore } from '../../core/session.js'
import { setSessionSkill } from '../../skills/session-skill.js'
import {
  createSourceAliasState,
  HIDDEN_SOURCE_ALIAS_KEY,
  presentSourceAlias,
  type SourceAliasState,
  resolveSourceAlias,
} from '../../core/source-alias.js'
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
import { applyTraderStrategyPatch, getTraderStrategy } from './strategy.js'
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

interface SourcePresentationState {
  aliases: SourceAliasState
  realToDisplay: Record<string, string>
}

function replaceSourceReferences(text: string, aliases: SourceAliasState, toPublic: boolean): string {
  let result = text
  const pairs = toPublic
    ? Object.entries(aliases.realToAlias)
    : Object.entries(aliases.aliasToReal)
  for (const [from, to] of pairs) {
    result = result.split(from).join(to)
  }
  return result
}

function replaceSourceReferencesForDisplay(text: string, presentation: SourcePresentationState): string {
  let result = text
  for (const [alias, real] of Object.entries(presentation.aliases.aliasToReal)) {
    result = result.split(alias).join(presentation.realToDisplay[real] ?? real)
  }
  for (const [real, display] of Object.entries(presentation.realToDisplay)) {
    result = result.split(real).join(display)
  }
  return result
}

function replaceStringsDeep<T>(value: T, replace: (input: string) => string): T {
  if (typeof value === 'string') {
    return replace(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringsDeep(item, replace)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceStringsDeep(entry, replace)]),
    ) as T
  }
  return value
}

function toPublicSource<T extends { source: string }>(value: T, aliases: SourceAliasState): T {
  return { ...value, source: presentSourceAlias(aliases, value.source) }
}

function toInternalSource<T extends { source: string }>(value: T, aliases: SourceAliasState): T {
  return { ...value, source: resolveSourceAlias(aliases, value.source) }
}

function toPublicStrategy(strategy: TraderStrategy, aliases: SourceAliasState): TraderStrategy {
  return {
    ...strategy,
    sources: strategy.sources.map((source) => presentSourceAlias(aliases, source)),
  }
}

function toPublicSnapshot(snapshot: TraderPreflightSnapshot, aliases: SourceAliasState): TraderPreflightSnapshot {
  return {
    ...snapshot,
    warnings: snapshot.warnings.map((warning) => replaceSourceReferences(warning, aliases, true)),
    sourceSnapshots: snapshot.sourceSnapshots.map((entry) => toPublicSource(entry, aliases)),
  }
}

function createSkillContext(
  context: Record<string, unknown>,
  aliases: SourceAliasState,
): Record<string, unknown> {
  return {
    ...context,
    [HIDDEN_SOURCE_ALIAS_KEY]: aliases,
  }
}

function createSourcePresentationState(
  sources: string[],
  deps: TraderRunnerDeps,
): SourcePresentationState {
  const aliases = createSourceAliasState(sources)
  const realToDisplay = Object.fromEntries(
    sources.map((source) => {
      const account = deps.accountManager.getAccount(source) as { label?: string } | undefined
      return [source, account?.label?.trim() || source]
    }),
  )
  return { aliases, realToDisplay }
}

function externalizeSource<T extends { source: string }>(value: T, presentation: SourcePresentationState): T {
  return {
    ...replaceStringsDeep(value, (text) => replaceSourceReferencesForDisplay(text, presentation)),
    source: presentation.realToDisplay[value.source] ?? value.source,
  }
}

function externalizeRunnerResult(
  result: TraderRunnerResult,
  presentation: SourcePresentationState,
): TraderRunnerResult {
  return {
    ...replaceStringsDeep(result, (text) => replaceSourceReferencesForDisplay(text, presentation)),
    decision: result.decision ? externalizeSource(result.decision, presentation) : undefined,
  }
}

function summarizeMarketEvaluations(
  evaluations: Array<{ source: string; symbol: string; reason: string }>,
): string {
  const entries = evaluations
    .map((evaluation) => `${evaluation.symbol} on ${evaluation.source}: ${evaluation.reason.trim()}`)
    .filter((entry) => !entry.endsWith(':'))
  return entries.join(' ')
}

function resolveEmptyMarketScanReason(strategy: TraderStrategy, summary: string, evaluations: Array<{ source: string; symbol: string; reason: string }>): string {
  const normalizedSummary = summary.trim()
  if (normalizedSummary) return normalizedSummary
  const evaluationSummary = summarizeMarketEvaluations(evaluations)
  if (evaluationSummary) return evaluationSummary
  return 'No tradable candidate found.'
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
    filledCount: filled,
    pendingCount: pending,
    rejectedCount: rejected,
  }
}

async function runCandidatePipeline(params: {
  strategy: TraderStrategy
  candidate: TraderMarketCandidate
  preflightSnapshot: TraderPreflightSnapshot
  session: SessionStore
  deps: TraderRunnerDeps
  presentation: SourcePresentationState
}) {
  const { strategy, candidate, preflightSnapshot, session, deps, presentation } = params
  const { aliases: sourceAliases } = presentation
  const publicStrategy = toPublicStrategy(strategy, sourceAliases)
  const publicCandidate = toPublicSource(candidate, sourceAliases)
  const publicPreflightSnapshot = toPublicSnapshot(preflightSnapshot, sourceAliases)

  const thesis = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.tradeThesis,
    prompt: buildTradeThesisPrompt(publicStrategy, publicCandidate, publicPreflightSnapshot),
    schema: traderTradeThesisSchema,
    deps,
    skillContext: createSkillContext({
      strategy: publicStrategy,
      candidate: publicCandidate,
      snapshot: publicPreflightSnapshot,
      stage: 'trade-thesis',
    }, sourceAliases),
  })
  const thesisOutput = replaceStringsDeep(
    toInternalSource(thesis.output, sourceAliases),
    (text) => replaceSourceReferences(text, sourceAliases, false),
  )

  if (thesisOutput.status === 'no_trade') {
    updateBrainIfPresent(deps, ...thesisOutput.contextNotes)
    return buildSkipResult(thesisOutput.rationale, thesis.rawText)
  }

  // Risk review must use a fresh account snapshot because the earlier AI stages may take minutes.
  const riskSnapshot = await buildPreflightSnapshot(strategy, deps)
  if (riskSnapshot.warnings.some((warning) => warning.includes('not available'))) {
    return { fatal: buildSkipResult(riskSnapshot.warnings.join(' '), thesis.rawText) }
  }
  const publicRiskSnapshot = toPublicSnapshot(riskSnapshot, sourceAliases)
  const publicThesis = toPublicSource(thesisOutput, sourceAliases)

  const risk = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.riskCheck,
    prompt: buildRiskCheckPrompt(publicStrategy, publicThesis, publicRiskSnapshot),
    schema: traderRiskCheckSchema,
    deps,
    skillContext: createSkillContext({
      strategy: publicStrategy,
      thesis: publicThesis,
      snapshot: publicRiskSnapshot,
      stage: 'risk-check',
    }, sourceAliases),
  })
  const riskOutput = replaceStringsDeep(
    toInternalSource(risk.output, sourceAliases),
    (text) => replaceSourceReferences(text, sourceAliases, false),
  )

  if (riskOutput.verdict !== 'pass') {
    return buildSkipResult(riskOutput.rationale, risk.rawText)
  }
  const publicRisk = toPublicSource(riskOutput, sourceAliases)

  const plan = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.tradePlan,
    prompt: buildTradePlanPrompt(publicStrategy, publicThesis, publicRisk),
    schema: traderTradePlanSchema,
    deps,
    skillContext: createSkillContext({
      strategy: publicStrategy,
      thesis: publicThesis,
      risk: publicRisk,
      stage: 'trade-plan',
    }, sourceAliases),
  })
  const planOutput = replaceStringsDeep(
    toInternalSource(plan.output, sourceAliases),
    (text) => replaceSourceReferences(text, sourceAliases, false),
  )

  if (planOutput.status !== 'plan_ready' || planOutput.orders.length === 0) {
    updateBrainIfPresent(deps, planOutput.brainUpdate)
    return buildSkipResult(planOutput.rationale, plan.rawText)
  }

  const hardRiskBlock = getHardRiskBudgetViolation(strategy, riskSnapshot, planOutput)
  if (hardRiskBlock) {
    updateBrainIfPresent(deps, planOutput.brainUpdate)
    return buildSkipResult(hardRiskBlock, plan.rawText)
  }
  const publicPlan = toPublicSource(planOutput, sourceAliases)

  const execute = await runSkillStage({
    session,
    skillId: TRADER_SKILLS.tradeExecute,
    prompt: buildTradeExecutePrompt(publicStrategy, publicPlan),
    schema: traderTradeExecuteSchema,
    deps,
    skillContext: createSkillContext({
      strategy: publicStrategy,
      plan: publicPlan,
      stage: 'trade-execute',
    }, sourceAliases),
  })
  const executeOutput = replaceStringsDeep(
    toInternalSource(execute.output, sourceAliases),
    (text) => replaceSourceReferences(text, sourceAliases, false),
  )

  if (executeOutput.status !== 'execute') {
    updateBrainIfPresent(deps, executeOutput.brainUpdate)
    return buildSkipResult(executeOutput.rationale, execute.rawText)
  }

  const executeScript = getSkillScript('trader-execute-plan')
  if (!executeScript) {
    throw new Error('Missing trader-execute-plan script')
  }

  const brainUpdate = updateBrainIfPresent(deps, planOutput.brainUpdate, executeOutput.brainUpdate)

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
      plan: planOutput,
      stage: 'trade-execute-script',
    },
  }, {
    source: planOutput.source,
    commitMessage: planOutput.commitMessage,
    orders: planOutput.orders,
  })

  const executionOutcome = buildExecutionOutcome(planOutput, executionResult, executeOutput.rationale)
  if (executionOutcome.rejectedCount > 0 && executionOutcome.filledCount === 0 && executionOutcome.pendingCount === 0) {
    return {
      status: 'skip' as const,
      reason: executionOutcome.rationale,
      rawText: JSON.stringify(executionResult, null, 2),
    }
  }

  const decision: TraderDecision = {
    status: 'trade',
    strategyId: strategy.id,
    source: planOutput.source,
    symbol: planOutput.symbol,
    chosenScenario: planOutput.chosenScenario,
    rationale: executionOutcome.rationale,
    invalidation: planOutput.invalidation,
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

  const presentation = createSourcePresentationState(strategy.sources, deps)
  const { aliases: sourceAliases } = presentation
  const publicStrategy = toPublicStrategy(strategy, sourceAliases)
  const snapshot = await buildPreflightSnapshot(strategy, deps)
  if (snapshot.warnings.some((warning) => warning.includes('not available'))) {
    return externalizeRunnerResult({ status: 'skip', reason: snapshot.warnings.join(' ') }, presentation)
  }
  const publicSnapshot = toPublicSnapshot(snapshot, sourceAliases)

  const scan = await runSkillStage({
    session: params.session,
    skillId: TRADER_SKILLS.marketScan,
    prompt: buildMarketScanPrompt(publicStrategy, publicSnapshot),
    schema: traderMarketScanSchema,
    deps,
    skillContext: createSkillContext({
      strategy: publicStrategy,
      snapshot: publicSnapshot,
      stage: 'market-scan',
    }, sourceAliases),
  })
  const scanOutput = {
    ...replaceStringsDeep(scan.output, (text) => replaceSourceReferences(text, sourceAliases, false)),
    candidates: scan.output.candidates.map((candidate) => replaceStringsDeep(
      toInternalSource(candidate, sourceAliases),
      (text) => replaceSourceReferences(text, sourceAliases, false),
    )),
    evaluations: scan.output.evaluations.map((evaluation) => replaceStringsDeep(
      toInternalSource(evaluation, sourceAliases),
      (text) => replaceSourceReferences(text, sourceAliases, false),
    )),
  }

  if (scanOutput.candidates.length === 0) {
    return externalizeRunnerResult({
      status: 'skip',
      reason: resolveEmptyMarketScanReason(strategy, scanOutput.summary, scanOutput.evaluations),
      rawText: scan.rawText,
    }, presentation)
  }

  let lastSkip: TraderRunnerResult = {
    status: 'skip',
    reason: scanOutput.summary || 'No tradable candidate survived the pipeline.',
    rawText: scan.rawText,
  }

  for (const candidate of scanOutput.candidates) {
    const result = await runCandidatePipeline({
      strategy,
      candidate,
      preflightSnapshot: snapshot,
      session: params.session,
      deps,
      presentation,
    })

    if ('fatal' in result) {
      return externalizeRunnerResult(result.fatal, presentation)
    }
    if (result.status === 'done') {
      return externalizeRunnerResult(result, presentation)
    }
    lastSkip = result
  }

  return externalizeRunnerResult(lastSkip, presentation)
}

export async function runTraderReview(
  strategyId: string | undefined,
  deps: TraderRunnerDeps,
  meta?: { trigger?: 'manual' | 'scheduled'; jobId?: string; jobName?: string },
): Promise<TraderReviewResult> {
  const strategy = strategyId ? await getTraderStrategy(strategyId) : null
  const sources = strategy?.sources ?? deps.accountManager.listAccounts().map((account) => account.id)
  const presentation = createSourcePresentationState(sources, deps)
  const { aliases: sourceAliases } = presentation
  const publicStrategy = strategy ? toPublicStrategy(strategy, sourceAliases) : null
  const publicSources = sources.map((source) => presentSourceAlias(sourceAliases, source))
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
    prompt: buildTraderReviewPrompt(publicStrategy, publicSources),
    schema: traderTradeReviewSchema,
    deps: deps as TraderRunnerDeps,
    skillContext: createSkillContext({
      strategy: publicStrategy,
      sources: publicSources,
      stage: 'trade-review',
    }, sourceAliases),
  })
  const reviewOutput = replaceStringsDeep(
    review.output,
    (text) => replaceSourceReferencesForDisplay(
      replaceSourceReferences(text, sourceAliases, false),
      presentation,
    ),
  )

  let updated = true
  let patchApplied = false
  let patchSummary = reviewOutput.patchSummary
  let summary = reviewOutput.summary
  let yamlDiff: string | undefined

  if (strategyId && reviewOutput.strategyPatch) {
    try {
      const patchResult = await applyTraderStrategyPatch(strategyId, reviewOutput.strategyPatch)
      patchApplied = patchResult.patchApplied
      yamlDiff = patchResult.patchApplied ? patchResult.changeReport.yamlDiff : undefined
      patchSummary = patchSummary ?? patchResult.changeReport.summary
      if (!patchApplied && !patchSummary) {
        patchSummary = 'Review suggested no effective YAML change.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updated = false
      patchApplied = false
      patchSummary = `Automatic strategy update failed: ${message}`
      summary = `${summary}\n\nStrategy update failed: ${message}`
    }
  }

  deps.brain.updateFrontalLobe(reviewOutput.brainUpdate)
  await deps.eventLog.append('trader.review.done', {
    strategyId,
    trigger: meta?.trigger ?? 'manual',
    jobId: meta?.jobId,
    jobName: meta?.jobName,
    updated,
    summary,
    patchApplied,
    patchSummary,
    yamlDiff,
  })
  return {
    updated,
    summary,
    strategyId,
    patchApplied,
    patchSummary,
    yamlDiff,
  }
}
