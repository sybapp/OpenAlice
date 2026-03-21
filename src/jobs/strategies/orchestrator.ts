import type { SessionStore } from '../../core/session.js'
import {
  createSourceAliasState,
  HIDDEN_SOURCE_ALIAS_KEY,
  presentSourceAlias,
  type SourceAliasState,
  resolveSourceAlias,
} from '../../core/source-alias.js'
import { traderTradeReviewSchema } from './workflow-stages.js'
import { executeSkillScript } from '../../skills/script-service.js'
import {
  buildTraderReviewPrompt,
} from './prompt.js'
import {
  runTraderStageAgent,
  type TraderStageAgentTrace,
  type TraderStageRequiredScriptCall,
} from './stage-agent.js'
import {
  buildTradeExecutionOutcome,
  buildTradeExecutionRunnerResult,
  buildTradePlanRouteRuntime,
  buildTraderSkipResult,
  createTraderWorkflowAgentStageDefinitions,
  resolveEmptyMarketScanReason,
  resolveRiskSnapshotFailureRouteForWarnings,
  resolveTraderWorkflowStageRoute,
  TRADER_SKILLS,
  type TraderWorkflowAgentStageDefinition,
  type TraderWorkflowStageTransitionRoute,
} from './workflow-stages.js'
import { applyTraderStrategyPatch, getTraderStrategy } from './strategy.js'
import { TraderWorkflowStateMachine } from './workflow-state.js'
import type {
  TraderMarketCandidate,
  TraderReviewResult,
  TraderRunnerDeps,
  TraderRunnerResult,
  TraderStrategy,
  TraderPreflightSnapshot,
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

function attachAgentTrace<T extends object>(data: T, trace: TraderStageAgentTrace): T & { agentTrace: TraderStageAgentTrace } {
  return {
    ...data,
    agentTrace: trace,
  }
}

function toEventDataRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  return { ...(data as Record<string, unknown>) }
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
      ...toEventDataRecord(data),
    })
  }

  private async applyStageRoute<TData>(
    stage: TraderWorkflowStage,
    route: TraderWorkflowStageTransitionRoute<TData>,
  ): Promise<void> {
    await this.appendStageEvent(stage, route.status, route.eventData)
    if (route.brainUpdates?.length) {
      updateBrainIfPresent(this.deps, ...route.brainUpdates)
    }
    if (route.completeWorkflow) {
      this.complete()
    }
  }

  private async routeAgentStage<TPublic, TInternal extends object, TEventData = TInternal, TRuntime = Record<string, unknown> | undefined>(
    definition: TraderWorkflowAgentStageDefinition<TPublic, TInternal, TEventData, TRuntime>,
    result: TraderStageRunResult<TInternal>,
  ): Promise<TraderWorkflowStageTransitionRoute<TEventData> | null> {
    const route = resolveTraderWorkflowStageRoute(definition, {
      output: result.output,
      rawText: result.rawText,
      eventData: attachAgentTrace(result.output, result.trace) as TEventData,
    })
    if (!route) return null
    await this.applyStageRoute(definition.stage, route)
    return route
  }

  private async runAgentStage<TPublic, TInternal extends object>(params: {
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
    const riskSnapshotFailureRoute = resolveRiskSnapshotFailureRouteForWarnings(thesisOutput, riskSnapshot, thesis.rawText)
    if (riskSnapshotFailureRoute) {
      await this.applyStageRoute('risk-check', riskSnapshotFailureRoute)
      return {
        decision: riskSnapshotFailureRoute.decision === 'next-candidate' ? 'next-candidate' : 'stop-run',
        result: riskSnapshotFailureRoute.runnerResult ?? buildTraderSkipResult(riskSnapshot.warnings.join(' '), thesis.rawText),
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
      runtime: buildTradePlanRouteRuntime(this.strategy, riskSnapshot, plan.output),
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
    if (plan.output.status !== 'plan_ready') {
      throw new Error('Trade plan advanced without a plan_ready payload.')
    }
    const planOutput = plan.output
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

    const brainUpdate = updateBrainIfPresent(this.deps, planOutput.brainUpdate, executeOutput.brainUpdate)

    let executionResult: unknown
    try {
      const execution = await executeSkillScript({
        scriptId: 'trader-execute-plan',
        context: {
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
        },
        input: {
          source: planOutput.source,
          commitMessage: planOutput.commitMessage,
          orders: planOutput.orders,
        },
      })
      executionResult = execution.output
    } catch (error) {
      await this.appendStageEvent('trade-execute-script', 'failed', {
        source: planOutput.source,
        symbol: planOutput.symbol,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    const executionOutcome = buildTradeExecutionOutcome(planOutput, executionResult, executeOutput.rationale)
    const executionRawText = JSON.stringify(executionResult, null, 2)
    const executeScriptDefinition = this.stages.tradeExecuteScript()
    const executeScriptRoute = resolveTraderWorkflowStageRoute(executeScriptDefinition, {
      output: {
        source: planOutput.source,
        symbol: planOutput.symbol,
        commitMessage: planOutput.commitMessage,
        outcome: executionOutcome,
        result: executionResult,
      },
      rawText: executionRawText,
      eventData: {
        source: planOutput.source,
        symbol: planOutput.symbol,
        commitMessage: planOutput.commitMessage,
        outcome: executionOutcome,
        result: executionResult,
      },
    })
    if (!executeScriptRoute) {
      throw new Error('Trade execute script stage is missing workflow transitions.')
    }
    await this.applyStageRoute('trade-execute-script', executeScriptRoute)
    if (executeScriptRoute.decision !== 'advance') {
      return {
        decision: executeScriptRoute.decision,
        result: executeScriptRoute.runnerResult ?? buildTraderSkipResult(executionOutcome.rationale, executionRawText),
      }
    }

    return {
      decision: 'done',
      result: buildTradeExecutionRunnerResult({
        strategyId: this.strategy.id,
        plan: planOutput,
        outcome: executionOutcome,
        brainUpdate,
        rawText: executionRawText,
      }),
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
