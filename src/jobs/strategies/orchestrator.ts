import type { SessionStore } from '../../core/session.js'
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
  buildTraderReviewPrompt,
} from './prompt.js'
import {
  buildMarketScanTask,
  buildRiskCheckTask,
  buildTradeExecuteTask,
  buildTradePlanTask,
  buildTradeThesisTask,
} from './orchestrator-prompts.js'
import {
  runTraderStageAgent,
  type TraderStageAgentTrace,
  type TraderStageRequiredScriptCall,
} from './stage-agent.js'
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
  TraderWorkflowStage,
  TraderWorkflowStageEventPayload,
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

interface TraderRunMeta {
  runId?: string
  jobId?: string
  jobName?: string
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

async function appendTraderStageEvent(
  deps: TraderRunnerDeps,
  meta: TraderRunMeta,
  strategyId: string,
  stage: TraderWorkflowStage,
  status: TraderWorkflowStageEventPayload['status'],
  data: unknown,
): Promise<void> {
  if (!meta.runId || !meta.jobId) return
  await deps.eventLog.append('trader.stage', {
    runId: meta.runId,
    jobId: meta.jobId,
    jobName: meta.jobName,
    strategyId,
    stage,
    status,
    data,
  } satisfies TraderWorkflowStageEventPayload)
}

function attachAgentTrace<T extends Record<string, unknown>>(data: T, trace: TraderStageAgentTrace): T & { agentTrace: TraderStageAgentTrace } {
  return {
    ...data,
    agentTrace: trace,
  }
}

function buildMarketScanRequiredScriptCalls(strategy: TraderStrategy): TraderStageRequiredScriptCall[] {
  return [
    ...strategy.sources.map((source) => ({
      id: 'trader-account-state',
      match: { source },
      rationale: `Load fresh account state for ${source}.`,
    })),
    ...strategy.universe.symbols.flatMap((symbol) => ([
      {
        id: 'analysis-brooks',
        match: { asset: strategy.universe.asset, symbol },
        rationale: `Gather Brooks structure for ${symbol}.`,
      },
      {
        id: 'analysis-ict-smc',
        match: { asset: strategy.universe.asset, symbol },
        rationale: `Gather ICT/SMC structure for ${symbol}.`,
      },
    ])),
  ]
}

function buildTradeThesisRequiredScriptCalls(strategy: TraderStrategy, candidate: TraderMarketCandidate): TraderStageRequiredScriptCall[] {
  return [
    {
      id: 'trader-account-state',
      match: { source: candidate.source },
      rationale: `Load fresh account state for ${candidate.source}.`,
    },
    {
      id: 'analysis-brooks',
      match: { asset: strategy.universe.asset, symbol: candidate.symbol },
      rationale: `Gather Brooks structure for ${candidate.symbol}.`,
    },
    {
      id: 'analysis-ict-smc',
      match: { asset: strategy.universe.asset, symbol: candidate.symbol },
      rationale: `Gather ICT/SMC structure for ${candidate.symbol}.`,
    },
  ]
}

function buildSingleSourceRequiredScriptCall(source: string, stageLabel: string): TraderStageRequiredScriptCall[] {
  return [{
    id: 'trader-account-state',
    match: { source },
    rationale: `Reload fresh account state for ${source} during ${stageLabel}.`,
  }]
}

function validateMarketScanOutput(
  strategy: TraderStrategy,
  output: { candidates: TraderMarketCandidate[]; evaluations: Array<{ source: string; symbol: string; verdict: string }> },
) {
  if (output.candidates.length === 0 && output.evaluations.length === 0) {
    throw new Error('Market scan cannot return an all-empty payload.')
  }
  const expectedPairs = strategy.sources.flatMap((source) => strategy.universe.symbols.map((symbol) => `${source}::${symbol}`))
  const evaluatedPairs = new Set(output.evaluations.map((evaluation) => `${evaluation.source}::${evaluation.symbol}`))
  const invalidEvaluations = output.evaluations.filter((evaluation) => !expectedPairs.includes(`${evaluation.source}::${evaluation.symbol}`))
  if (invalidEvaluations.length > 0) {
    throw new Error(`Market scan returned evaluations outside configured coverage: ${invalidEvaluations.map((evaluation) => `${evaluation.source}::${evaluation.symbol}`).join(', ')}`)
  }
  const missingPairs = expectedPairs.filter((pair) => !evaluatedPairs.has(pair))
  if (missingPairs.length > 0) {
    throw new Error(`Market scan is missing explicit evaluations for: ${missingPairs.join(', ')}`)
  }
  const invalidCandidates = output.candidates.filter((candidate) => !expectedPairs.includes(`${candidate.source}::${candidate.symbol}`))
  if (invalidCandidates.length > 0) {
    throw new Error(`Market scan returned candidates outside configured coverage: ${invalidCandidates.map((candidate) => `${candidate.source}::${candidate.symbol}`).join(', ')}`)
  }
}

function validateThesisOutput(candidate: TraderMarketCandidate, output: { source: string; symbol: string }) {
  if (output.source !== candidate.source || output.symbol !== candidate.symbol) {
    throw new Error(`Trade thesis output must stay on ${candidate.symbol} at ${candidate.source}.`)
  }
}

function validateRiskOutput(thesis: { source: string; symbol: string }, output: { source: string; symbol: string }) {
  if (output.source !== thesis.source || output.symbol !== thesis.symbol) {
    throw new Error(`Risk check output must stay on ${thesis.symbol} at ${thesis.source}.`)
  }
}

function validateTradePlanOutput(thesis: { source: string; symbol: string; chosenScenario: string }, output: TraderTradePlanReadyResult | any) {
  if (output.source !== thesis.source || output.symbol !== thesis.symbol) {
    throw new Error(`Trade plan output must stay on ${thesis.symbol} at ${thesis.source}.`)
  }
  if (output.chosenScenario !== thesis.chosenScenario) {
    throw new Error('Trade plan must preserve the thesis chosenScenario.')
  }
  if (output.status === 'plan_ready' && output.orders.length === 0) {
    throw new Error('Trade plan with status "plan_ready" must include at least one order.')
  }
}

function validateTradeExecuteOutput(plan: TraderTradePlanReadyResult, output: { source: string; symbol: string }) {
  if (output.source !== plan.source || output.symbol !== plan.symbol) {
    throw new Error(`Trade execute output must stay on ${plan.symbol} at ${plan.source}.`)
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

interface CandidatePipelineResultDone extends TraderRunnerResult {
  status: 'done'
}

interface CandidatePipelineResultSkip extends TraderRunnerResult {
  status: 'skip'
}

interface CandidatePipelineResultFatal {
  fatal: TraderRunnerResult
}

type CandidatePipelineResult = CandidatePipelineResultDone | CandidatePipelineResultSkip | CandidatePipelineResultFatal

class TraderWorkflowRun {
  private readonly presentation: SourcePresentationState
  private readonly sourceAliases: SourceAliasState
  private readonly publicStrategy: TraderStrategy
  private readonly meta: TraderRunMeta
  private stageState: 'boot' | TraderWorkflowStage | 'completed' = 'boot'

  constructor(
    private readonly params: { jobId: string; strategyId: string; session: SessionStore; runId?: string; jobName?: string },
    private readonly deps: TraderRunnerDeps,
    private readonly strategy: TraderStrategy,
  ) {
    this.presentation = createSourcePresentationState(strategy.sources, deps)
    this.sourceAliases = this.presentation.aliases
    this.publicStrategy = toPublicStrategy(strategy, this.sourceAliases)
    this.meta = {
      runId: params.runId,
      jobId: params.jobId,
      jobName: params.jobName,
    }
  }

  async run(): Promise<TraderRunnerResult> {
    const snapshot = await buildPreflightSnapshot(this.strategy, this.deps)
    if (snapshot.warnings.some((warning) => warning.includes('not available'))) {
      return this.externalize({ status: 'skip', reason: snapshot.warnings.join(' ') })
    }

    const scan = await this.runMarketScan(snapshot)
    if (scan.candidates.length === 0) {
      return this.externalize({
        status: 'skip',
        reason: resolveEmptyMarketScanReason(this.strategy, scan.summary, scan.evaluations),
        rawText: scan.rawText,
      })
    }

    let lastSkip: TraderRunnerResult = {
      status: 'skip',
      reason: scan.summary || 'No tradable candidate survived the pipeline.',
      rawText: scan.rawText,
    }

    for (const candidate of scan.candidates) {
      const result = await this.runCandidatePipeline(candidate, snapshot)
      if ('fatal' in result) {
        return this.externalize(result.fatal)
      }
      if (result.status === 'done') {
        return this.externalize(result)
      }
      lastSkip = result
    }

    return this.externalize(lastSkip)
  }

  private externalize(result: TraderRunnerResult): TraderRunnerResult {
    return externalizeRunnerResult(result, this.presentation)
  }

  private transition(stage: TraderWorkflowStage) {
    this.stageState = stage
  }

  private complete() {
    this.stageState = 'completed'
  }

  private async appendStageEvent(
    stage: TraderWorkflowStage,
    status: TraderWorkflowStageEventPayload['status'],
    data: unknown,
  ): Promise<void> {
    this.transition(stage)
    await appendTraderStageEvent(this.deps, this.meta, this.strategy.id, stage, status, {
      workflowState: this.stageState,
      ...((data ?? {}) as Record<string, unknown>),
    })
  }

  private async runMarketScan(preflightSnapshot: TraderPreflightSnapshot) {
    const publicSnapshot = toPublicSnapshot(preflightSnapshot, this.sourceAliases)
    let scan
    try {
      scan = await runTraderStageAgent({
        session: this.params.session,
        skillId: TRADER_SKILLS.marketScan,
        task: buildMarketScanTask(this.publicStrategy, publicSnapshot),
        schema: traderMarketScanSchema,
        deps: this.deps,
        skillContext: createSkillContext({
          strategy: this.publicStrategy,
          snapshot: publicSnapshot,
          stage: 'market-scan',
          workflowState: this.stageState,
        }, this.sourceAliases),
        requiredScriptCalls: buildMarketScanRequiredScriptCalls(this.publicStrategy),
      })
    } catch (error) {
      await this.appendStageEvent('market-scan', 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const scanOutput = {
      ...replaceStringsDeep(scan.output, (text) => replaceSourceReferences(text, this.sourceAliases, false)),
      candidates: scan.output.candidates.map((candidate) => replaceStringsDeep(
        toInternalSource(candidate, this.sourceAliases),
        (text) => replaceSourceReferences(text, this.sourceAliases, false),
      )),
      evaluations: scan.output.evaluations.map((evaluation) => replaceStringsDeep(
        toInternalSource(evaluation, this.sourceAliases),
        (text) => replaceSourceReferences(text, this.sourceAliases, false),
      )),
      rawText: scan.rawText,
    }
    validateMarketScanOutput(this.strategy, scanOutput)

    if (scanOutput.candidates.length === 0) {
      await this.appendStageEvent('market-scan', 'skipped', attachAgentTrace(scanOutput, scan.trace))
      return scanOutput
    }
    await this.appendStageEvent('market-scan', 'completed', attachAgentTrace(scanOutput, scan.trace))
    return scanOutput
  }

  private async runCandidatePipeline(
    candidate: TraderMarketCandidate,
    preflightSnapshot: TraderPreflightSnapshot,
  ): Promise<CandidatePipelineResult> {
    const publicCandidate = toPublicSource(candidate, this.sourceAliases)
    const publicPreflightSnapshot = toPublicSnapshot(preflightSnapshot, this.sourceAliases)

    let thesis
    try {
      thesis = await runTraderStageAgent({
        session: this.params.session,
        skillId: TRADER_SKILLS.tradeThesis,
        task: buildTradeThesisTask(this.publicStrategy, publicCandidate, publicPreflightSnapshot),
        schema: traderTradeThesisSchema,
        deps: this.deps,
        skillContext: createSkillContext({
          strategy: this.publicStrategy,
          candidate: publicCandidate,
          snapshot: publicPreflightSnapshot,
          stage: 'trade-thesis',
          workflowState: this.stageState,
        }, this.sourceAliases),
        requiredScriptCalls: buildTradeThesisRequiredScriptCalls(this.publicStrategy, publicCandidate),
      })
    } catch (error) {
      await this.appendStageEvent('trade-thesis', 'failed', {
        source: candidate.source,
        symbol: candidate.symbol,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const thesisOutput = replaceStringsDeep(
      toInternalSource(thesis.output, this.sourceAliases),
      (text) => replaceSourceReferences(text, this.sourceAliases, false),
    )
    validateThesisOutput(candidate, thesisOutput)

    if (thesisOutput.status === 'no_trade') {
      await this.appendStageEvent('trade-thesis', 'skipped', attachAgentTrace(thesisOutput, thesis.trace))
      updateBrainIfPresent(this.deps, ...thesisOutput.contextNotes)
      return buildSkipResult(thesisOutput.rationale, thesis.rawText)
    }
    await this.appendStageEvent('trade-thesis', 'completed', attachAgentTrace(thesisOutput, thesis.trace))

    const riskSnapshot = await buildPreflightSnapshot(this.strategy, this.deps)
    if (riskSnapshot.warnings.some((warning) => warning.includes('not available'))) {
      await this.appendStageEvent('risk-check', 'failed', {
        source: thesisOutput.source,
        symbol: thesisOutput.symbol,
        error: riskSnapshot.warnings.join(' '),
      })
      return { fatal: buildSkipResult(riskSnapshot.warnings.join(' '), thesis.rawText) }
    }
    const publicRiskSnapshot = toPublicSnapshot(riskSnapshot, this.sourceAliases)
    const publicThesis = toPublicSource(thesisOutput, this.sourceAliases)

    let risk
    try {
      risk = await runTraderStageAgent({
        session: this.params.session,
        skillId: TRADER_SKILLS.riskCheck,
        task: buildRiskCheckTask(this.publicStrategy, publicThesis, publicRiskSnapshot),
        schema: traderRiskCheckSchema,
        deps: this.deps,
        skillContext: createSkillContext({
          strategy: this.publicStrategy,
          thesis: publicThesis,
          snapshot: publicRiskSnapshot,
          stage: 'risk-check',
          workflowState: this.stageState,
        }, this.sourceAliases),
        requiredScriptCalls: buildSingleSourceRequiredScriptCall(publicThesis.source, 'risk-check'),
      })
    } catch (error) {
      await this.appendStageEvent('risk-check', 'failed', {
        source: thesisOutput.source,
        symbol: thesisOutput.symbol,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const riskOutput = replaceStringsDeep(
      toInternalSource(risk.output, this.sourceAliases),
      (text) => replaceSourceReferences(text, this.sourceAliases, false),
    )
    validateRiskOutput(thesisOutput, riskOutput)

    if (riskOutput.verdict !== 'pass') {
      await this.appendStageEvent('risk-check', 'skipped', attachAgentTrace(riskOutput, risk.trace))
      return buildSkipResult(riskOutput.rationale, risk.rawText)
    }
    await this.appendStageEvent('risk-check', 'completed', attachAgentTrace(riskOutput, risk.trace))
    const publicRisk = toPublicSource(riskOutput, this.sourceAliases)

    let plan
    try {
      plan = await runTraderStageAgent({
        session: this.params.session,
        skillId: TRADER_SKILLS.tradePlan,
        task: buildTradePlanTask(this.publicStrategy, publicThesis, publicRisk),
        schema: traderTradePlanSchema,
        deps: this.deps,
        skillContext: createSkillContext({
          strategy: this.publicStrategy,
          thesis: publicThesis,
          risk: publicRisk,
          stage: 'trade-plan',
          workflowState: this.stageState,
        }, this.sourceAliases),
        requiredScriptCalls: buildSingleSourceRequiredScriptCall(publicThesis.source, 'trade-plan'),
      })
    } catch (error) {
      await this.appendStageEvent('trade-plan', 'failed', {
        source: thesisOutput.source,
        symbol: thesisOutput.symbol,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const planOutput = replaceStringsDeep(
      toInternalSource(plan.output, this.sourceAliases),
      (text) => replaceSourceReferences(text, this.sourceAliases, false),
    )
    validateTradePlanOutput(thesisOutput, planOutput)

    if (planOutput.status !== 'plan_ready' || planOutput.orders.length === 0) {
      await this.appendStageEvent('trade-plan', 'skipped', attachAgentTrace(planOutput, plan.trace))
      updateBrainIfPresent(this.deps, planOutput.brainUpdate)
      return buildSkipResult(planOutput.rationale, plan.rawText)
    }

    const hardRiskBlock = getHardRiskBudgetViolation(this.strategy, riskSnapshot, planOutput)
    if (hardRiskBlock) {
      await this.appendStageEvent('trade-plan', 'skipped', attachAgentTrace({
        ...planOutput,
        rationale: hardRiskBlock,
        gate: 'hard-risk-budget',
      }, plan.trace))
      updateBrainIfPresent(this.deps, planOutput.brainUpdate)
      return buildSkipResult(hardRiskBlock, plan.rawText)
    }
    await this.appendStageEvent('trade-plan', 'completed', attachAgentTrace(planOutput, plan.trace))
    const publicPlan = toPublicSource(planOutput, this.sourceAliases)

    let execute
    try {
      execute = await runTraderStageAgent({
        session: this.params.session,
        skillId: TRADER_SKILLS.tradeExecute,
        task: buildTradeExecuteTask(this.publicStrategy, publicPlan),
        schema: traderTradeExecuteSchema,
        deps: this.deps,
        skillContext: createSkillContext({
          strategy: this.publicStrategy,
          plan: publicPlan,
          stage: 'trade-execute',
          workflowState: this.stageState,
        }, this.sourceAliases),
      })
    } catch (error) {
      await this.appendStageEvent('trade-execute', 'failed', {
        source: planOutput.source,
        symbol: planOutput.symbol,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const executeOutput = replaceStringsDeep(
      toInternalSource(execute.output, this.sourceAliases),
      (text) => replaceSourceReferences(text, this.sourceAliases, false),
    )
    validateTradeExecuteOutput(planOutput, executeOutput)

    if (executeOutput.status !== 'execute') {
      await this.appendStageEvent('trade-execute', 'skipped', attachAgentTrace(executeOutput, execute.trace))
      updateBrainIfPresent(this.deps, executeOutput.brainUpdate)
      return buildSkipResult(executeOutput.rationale, execute.rawText)
    }
    await this.appendStageEvent('trade-execute', 'completed', attachAgentTrace(executeOutput, execute.trace))

    const executeScript = getSkillScript('trader-execute-plan')
    if (!executeScript) {
      await this.appendStageEvent('trade-execute-script', 'failed', {
        source: planOutput.source,
        symbol: planOutput.symbol,
        error: 'Missing trader-execute-plan script',
      })
      throw new Error('Missing trader-execute-plan script')
    }

    const brainUpdate = updateBrainIfPresent(this.deps, planOutput.brainUpdate, executeOutput.brainUpdate)

    const executionResult = await executeScript.run({
      config: this.deps.config,
      eventLog: this.deps.eventLog,
      brain: this.deps.brain,
      accountManager: this.deps.accountManager,
      marketData: this.deps.marketData,
      ohlcvStore: this.deps.ohlcvStore,
      newsStore: this.deps.newsStore,
      getAccountGit: this.deps.getAccountGit,
      invocation: {
        strategy: this.strategy,
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
      await this.appendStageEvent('trade-execute-script', 'skipped', {
        source: planOutput.source,
        symbol: planOutput.symbol,
        commitMessage: planOutput.commitMessage,
        outcome: executionOutcome,
        result: executionResult,
      })
      this.complete()
      return {
        status: 'skip',
        reason: executionOutcome.rationale,
        rawText: JSON.stringify(executionResult, null, 2),
      }
    }
    await this.appendStageEvent('trade-execute-script', 'completed', {
      source: planOutput.source,
      symbol: planOutput.symbol,
      commitMessage: planOutput.commitMessage,
      outcome: executionOutcome,
      result: executionResult,
    })
    this.complete()

    const decision: TraderDecision = {
      status: 'trade',
      strategyId: this.strategy.id,
      source: planOutput.source,
      symbol: planOutput.symbol,
      chosenScenario: planOutput.chosenScenario,
      rationale: executionOutcome.rationale,
      invalidation: planOutput.invalidation,
      actionsTaken: executionOutcome.actionsTaken,
      brainUpdate,
    }

    return {
      status: 'done',
      reason: decision.rationale,
      decision,
      rawText: JSON.stringify(executionResult, null, 2),
    }
  }
}

async function runTraderJobImpl(
  params: { jobId: string; strategyId: string; session: SessionStore; runId?: string; jobName?: string },
  deps: TraderRunnerDeps,
): Promise<TraderRunnerResult> {
  const strategy = await getTraderStrategy(params.strategyId)
  if (!strategy) {
    return { status: 'skip', reason: `Unknown strategy: ${params.strategyId}` }
  }
  if (!strategy.enabled) {
    return { status: 'skip', reason: `Strategy ${strategy.id} is disabled` }
  }
  return new TraderWorkflowRun(params, deps, strategy).run()
}

async function runTraderReviewImpl(
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

  const review = await runTraderStageAgent({
    session,
    skillId: TRADER_SKILLS.tradeReview,
    task: buildTraderReviewPrompt(publicStrategy, publicSources),
    schema: traderTradeReviewSchema,
    deps,
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

export class TraderOrchestrator {
  constructor(private readonly deps: TraderRunnerDeps) {}

  runJob(params: { jobId: string; strategyId: string; session: SessionStore; runId?: string; jobName?: string }) {
    return runTraderJobImpl(params, this.deps)
  }

  runReview(
    strategyId: string | undefined,
    meta?: { trigger?: 'manual' | 'scheduled'; jobId?: string; jobName?: string },
  ) {
    return runTraderReviewImpl(strategyId, this.deps, meta)
  }
}

export async function runTraderJob(
  params: { jobId: string; strategyId: string; session: SessionStore; runId?: string; jobName?: string },
  deps: TraderRunnerDeps,
): Promise<TraderRunnerResult> {
  return new TraderOrchestrator(deps).runJob(params)
}

export async function runTraderReview(
  strategyId: string | undefined,
  deps: TraderRunnerDeps,
  meta?: { trigger?: 'manual' | 'scheduled'; jobId?: string; jobName?: string },
): Promise<TraderReviewResult> {
  return new TraderOrchestrator(deps).runReview(strategyId, meta)
}
