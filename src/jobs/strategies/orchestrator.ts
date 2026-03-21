import type { SessionStore } from '../../core/session.js'
import {
  createSourceAliasState,
  HIDDEN_SOURCE_ALIAS_KEY,
  presentSourceAlias,
  type SourceAliasState,
  resolveSourceAlias,
} from '../../core/source-alias.js'
import { traderTradeReviewSchema } from './workflow-stages.js'
import { getSkillScript } from '../../skills/script-registry.js'
import {
  buildTraderReviewPrompt,
} from './prompt.js'
import {
  runTraderStageAgent,
  type TraderStageAgentTrace,
  type TraderStageRequiredScriptCall,
} from './stage-agent.js'
import {
  buildTraderSkipResult,
  createTraderWorkflowAgentStageDefinitions,
  resolveEmptyMarketScanReason,
  resolveHardRiskBudgetRoute,
  resolveTraderWorkflowStageRoute,
  resolveRiskSnapshotFailureRoute,
  resolveTradeExecuteScriptRoute,
  TRADER_SKILLS,
  type TraderWorkflowAgentStageDefinition,
  type TraderWorkflowStageTransitionRoute,
} from './workflow-stages.js'
import { applyTraderStrategyPatch, getTraderStrategy } from './strategy.js'
import { TraderWorkflowStateMachine } from './workflow-state.js'
import type {
  TraderDecision,
  TraderMarketCandidate,
  TraderPlannedOrder,
  TraderReviewResult,
  TraderRunnerDeps,
  TraderRunnerResult,
  TraderStrategy,
  TraderTradePlanReadyResult,
  TraderTradePlanResult,
  TraderPreflightSnapshot,
  TraderRiskCheckResult,
  TraderTradeExecuteResult,
  TraderTradeThesisResult,
  TraderWorkflowStage,
  TraderWorkflowStageEventPayload,
} from './types.js'

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

type CandidatePipelineResult =
  | { decision: 'done'; result: CandidatePipelineResultDone }
  | { decision: 'next-candidate'; result: TraderRunnerResult }
  | { decision: 'stop-run'; result: TraderRunnerResult }

interface TraderStageRunResult<T> {
  output: T
  rawText: string
  trace: TraderStageAgentTrace
}

class TraderWorkflowRun {
  private readonly presentation: SourcePresentationState
  private readonly sourceAliases: SourceAliasState
  private readonly publicStrategy: TraderStrategy
  private readonly meta: TraderRunMeta
  private readonly workflow = new TraderWorkflowStateMachine()
  private readonly stages: ReturnType<typeof createTraderWorkflowAgentStageDefinitions>

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
    this.stages = createTraderWorkflowAgentStageDefinitions({
      strategy: this.strategy,
      publicStrategy: this.publicStrategy,
      toPublicSnapshot: (snapshot) => toPublicSnapshot(snapshot, this.sourceAliases),
      toPublicSource: (value) => toPublicSource(value, this.sourceAliases),
      toInternalSource: (value) => toInternalSource(value, this.sourceAliases),
      replaceInternalStrings: (value) => replaceStringsDeep(
        value,
        (input) => replaceSourceReferences(input, this.sourceAliases, false),
      ),
    })
  }

  async run(): Promise<TraderRunnerResult> {
    const snapshot = await buildPreflightSnapshot(this.strategy, this.deps)
    if (snapshot.warnings.some((warning) => warning.includes('not available'))) {
      return this.externalize({ status: 'skip', reason: snapshot.warnings.join(' ') })
    }

    const scan = await this.runMarketScan(snapshot)
    if (scan.route && scan.route.decision !== 'advance') {
      return this.externalize({
        ...(scan.route.runnerResult ?? buildTraderSkipResult(
          resolveEmptyMarketScanReason(this.strategy, scan.output.summary, scan.output.evaluations),
          scan.output.rawText,
        )),
      })
    }

    let lastSkip: TraderRunnerResult = {
      status: 'skip',
      reason: scan.output.summary || 'No tradable candidate survived the pipeline.',
      rawText: scan.output.rawText,
    }

    for (const candidate of scan.output.candidates) {
      const result = await this.runCandidatePipeline(candidate, snapshot)
      if (result.decision === 'done' || result.decision === 'stop-run') {
        return this.externalize(result.result)
      }
      lastSkip = result.result
    }

    return this.externalize(lastSkip)
  }

  private externalize(result: TraderRunnerResult): TraderRunnerResult {
    return externalizeRunnerResult(result, this.presentation)
  }

  private buildStageSkillContext(
    stage: TraderWorkflowStage,
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    return createSkillContext({
      ...context,
      stage,
      workflowState: this.workflow.current,
    }, this.sourceAliases)
  }

  private complete() {
    this.workflow.complete()
  }

  private async appendStageEvent(
    stage: TraderWorkflowStage,
    status: TraderWorkflowStageEventPayload['status'],
    data: unknown,
  ): Promise<void> {
    const record = this.workflow.record(stage, status)
    await appendTraderStageEvent(this.deps, this.meta, this.strategy.id, stage, status, {
      previousWorkflowState: record.previousState,
      workflowState: record.workflowState,
      nextAllowedStages: record.allowedNextStages,
      ...((data ?? {}) as Record<string, unknown>),
    })
  }

  private async applyStageRoute(
    stage: TraderWorkflowStage,
    route: TraderWorkflowStageTransitionRoute<Record<string, unknown>>,
  ): Promise<void> {
    await this.appendStageEvent(stage, route.status, route.eventData)
    if (route.brainUpdates?.length) {
      updateBrainIfPresent(this.deps, ...route.brainUpdates)
    }
    if (route.completeWorkflow) {
      this.complete()
    }
  }

  private async routeAgentStage<TPublic, TInternal extends Record<string, unknown>>(
    definition: TraderWorkflowAgentStageDefinition<TPublic, TInternal>,
    result: TraderStageRunResult<TInternal>,
  ): Promise<TraderWorkflowStageTransitionRoute<Record<string, unknown>> | null> {
    const route = resolveTraderWorkflowStageRoute(definition, {
      output: result.output,
      rawText: result.rawText,
      eventData: attachAgentTrace(result.output, result.trace),
    })
    if (!route) return null
    await this.applyStageRoute(definition.stage, route)
    return route
  }

  private async runAgentStage<TPublic, TInternal>(params: {
    stage: TraderWorkflowStage
    skillId: string
    task: string
    schema: { parse: (value: unknown) => TPublic }
    context: Record<string, unknown>
    requiredScriptCalls?: TraderStageRequiredScriptCall[]
    transform: (output: TPublic) => TInternal
    validate?: (output: TInternal) => void
    onError?: (error: unknown) => Record<string, unknown>
  }): Promise<TraderStageRunResult<TInternal>> {
    let result
    try {
      result = await runTraderStageAgent({
        session: this.params.session,
        skillId: params.skillId,
        task: params.task,
        schema: params.schema,
        deps: this.deps,
        skillContext: this.buildStageSkillContext(params.stage, params.context),
        requiredScriptCalls: params.requiredScriptCalls,
      })
    } catch (error) {
      await this.appendStageEvent(params.stage, 'failed', params.onError?.(error) ?? {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    const output = params.transform(result.output)
    params.validate?.(output)
    return {
      output,
      rawText: result.rawText,
      trace: result.trace,
    }
  }

  private async runMarketScan(preflightSnapshot: TraderPreflightSnapshot) {
    const definition = this.stages.marketScan(preflightSnapshot)
    const scan = await this.runAgentStage(definition)
    const route = await this.routeAgentStage(definition, scan)
    return {
      output: { ...scan.output, rawText: scan.rawText },
      route,
    }
  }

  private async runCandidatePipeline(
    candidate: TraderMarketCandidate,
    preflightSnapshot: TraderPreflightSnapshot,
  ): Promise<CandidatePipelineResult> {
    const thesisDefinition = this.stages.tradeThesis(candidate, preflightSnapshot)
    const thesis = await this.runAgentStage(thesisDefinition)
    const thesisRoute = await this.routeAgentStage(thesisDefinition, thesis)
    if (thesisRoute && thesisRoute.decision !== 'advance') {
      return {
        decision: thesisRoute.decision,
        result: thesisRoute.runnerResult ?? buildTraderSkipResult('Trade thesis stopped the pipeline.', thesis.rawText),
      }
    }
    const thesisOutput = thesis.output

    const riskSnapshot = await buildPreflightSnapshot(this.strategy, this.deps)
    if (riskSnapshot.warnings.some((warning) => warning.includes('not available'))) {
      const route = resolveRiskSnapshotFailureRoute(thesisOutput, riskSnapshot.warnings, thesis.rawText)
      await this.applyStageRoute('risk-check', route)
      return {
        decision: route.decision,
        result: route.runnerResult ?? buildTraderSkipResult(riskSnapshot.warnings.join(' '), thesis.rawText),
      }
    }
    const riskDefinition = this.stages.riskCheck(thesisOutput, riskSnapshot)
    const risk = await this.runAgentStage(riskDefinition)
    const riskRoute = await this.routeAgentStage(riskDefinition, risk)
    if (riskRoute && riskRoute.decision !== 'advance') {
      return {
        decision: riskRoute.decision,
        result: riskRoute.runnerResult ?? buildTraderSkipResult('Risk check stopped the pipeline.', risk.rawText),
      }
    }
    const riskOutput = risk.output

    const planDefinition = this.stages.tradePlan(thesisOutput, riskOutput)
    const plan = await this.runAgentStage(planDefinition)
    const planRoute = resolveTraderWorkflowStageRoute(planDefinition, {
      output: plan.output,
      rawText: plan.rawText,
      eventData: attachAgentTrace(plan.output, plan.trace),
    })
    if (!planRoute) {
      throw new Error('Trade plan stage is missing workflow transitions.')
    }
    if (planRoute.decision !== 'advance') {
      await this.applyStageRoute(planDefinition.stage, planRoute)
      return {
        decision: planRoute.decision,
        result: planRoute.runnerResult ?? buildTraderSkipResult('Trade plan stopped the pipeline.', plan.rawText),
      }
    }
    const planOutput = plan.output

    const hardRiskBlock = getHardRiskBudgetViolation(this.strategy, riskSnapshot, planOutput)
    if (hardRiskBlock) {
      const route = resolveHardRiskBudgetRoute(
        planOutput,
        hardRiskBlock,
        plan.rawText,
        attachAgentTrace(planOutput, plan.trace),
      )
      await this.applyStageRoute('trade-plan', route)
      return {
        decision: route.decision,
        result: route.runnerResult ?? buildTraderSkipResult(hardRiskBlock, plan.rawText),
      }
    }
    await this.applyStageRoute(planDefinition.stage, planRoute)

    const executeDefinition = this.stages.tradeExecute(planOutput)
    const execute = await this.runAgentStage(executeDefinition)
    const executeRoute = await this.routeAgentStage(executeDefinition, execute)
    if (executeRoute && executeRoute.decision !== 'advance') {
      return {
        decision: executeRoute.decision,
        result: executeRoute.runnerResult ?? buildTraderSkipResult('Trade execute stopped the pipeline.', execute.rawText),
      }
    }
    const executeOutput = execute.output

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
    const executionRawText = JSON.stringify(executionResult, null, 2)
    const executeScriptRoute = resolveTradeExecuteScriptRoute({
      source: planOutput.source,
      symbol: planOutput.symbol,
      commitMessage: planOutput.commitMessage,
      executionOutcome,
      executionResult,
      rawText: executionRawText,
    })
    await this.applyStageRoute('trade-execute-script', executeScriptRoute)
    if (executeScriptRoute.decision !== 'advance') {
      return {
        decision: executeScriptRoute.decision,
        result: executeScriptRoute.runnerResult ?? buildTraderSkipResult(executionOutcome.rationale, executionRawText),
      }
    }

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
      decision: 'done',
      result: {
        status: 'done',
        reason: decision.rationale,
        decision,
        rawText: executionRawText,
      },
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
