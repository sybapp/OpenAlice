import {
  traderMarketScanSchema,
  traderRiskCheckSchema,
  traderTradeExecuteSchema,
  traderTradePlanSchema,
  traderTradeReviewSchema,
  traderTradeThesisSchema,
} from '../../skills/completion-schemas.js'
import {
  buildMarketScanTask,
  buildRiskCheckTask,
  buildTradeExecuteTask,
  buildTradePlanTask,
  buildTradeThesisTask,
} from './orchestrator-prompts.js'
import type { TraderStageRequiredScriptCall } from './stage-agent.js'
import type {
  TraderMarketCandidate,
  TraderMarketScanResult,
  TraderPreflightSnapshot,
  TraderRunnerResult,
  TraderRiskCheckResult,
  TraderStrategy,
  TraderTradeExecuteResult,
  TraderTradePlanReadyResult,
  TraderTradePlanResult,
  TraderTradeThesisResult,
  TraderWorkflowStage,
  TraderWorkflowStageStatus,
} from './types.js'

export const TRADER_SKILLS = {
  marketScan: 'trader-market-scan',
  tradeThesis: 'trader-trade-thesis',
  riskCheck: 'trader-risk-check',
  tradePlan: 'trader-trade-plan',
  tradeExecute: 'trader-trade-execute',
  tradeReview: 'trader-trade-review',
} as const

export type TraderWorkflowRuntimeState = 'boot' | TraderWorkflowStage | 'completed'

export const TRADER_WORKFLOW_ALLOWED_TRANSITIONS: Record<TraderWorkflowRuntimeState, readonly TraderWorkflowStage[]> = {
  boot: ['market-scan'],
  'market-scan': ['trade-thesis'],
  'trade-thesis': ['trade-thesis', 'risk-check'],
  'risk-check': ['trade-thesis', 'trade-plan'],
  'trade-plan': ['trade-thesis', 'trade-execute'],
  'trade-execute': ['trade-thesis', 'trade-execute-script'],
  'trade-execute-script': [],
  completed: [],
}

export interface TraderWorkflowAgentStageDefinition<TPublic, TInternal> {
  stage: TraderWorkflowStage
  skillId: string
  task: string
  schema: { parse: (value: unknown) => TPublic }
  context: Record<string, unknown>
  requiredScriptCalls?: TraderStageRequiredScriptCall[]
  transform: (output: TPublic) => TInternal
  validate?: (output: TInternal) => void
  onError?: (error: unknown) => Record<string, unknown>
  transitions?: readonly TraderWorkflowStageTransitionRule<TInternal, Record<string, unknown>, Record<string, unknown> | undefined>[]
}

export interface TraderWorkflowStageDefinition<TOutput, TData = Record<string, unknown>, TRuntime = Record<string, unknown> | undefined> {
  stage: TraderWorkflowStage
  transitions?: readonly TraderWorkflowStageTransitionRule<TOutput, TData, TRuntime>[]
}

export type TraderWorkflowTransitionDecision = 'advance' | 'next-candidate' | 'stop-run'

export interface TraderWorkflowStageTransitionRoute<TData = Record<string, unknown>> {
  status: TraderWorkflowStageStatus
  decision: TraderWorkflowTransitionDecision
  eventData: TData
  runnerResult?: TraderRunnerResult
  brainUpdates?: string[]
  completeWorkflow?: boolean
}

export interface TraderWorkflowStageTransitionRule<TOutput, TData = Record<string, unknown>, TRuntime = Record<string, unknown> | undefined> {
  when: (output: TOutput, context: { rawText: string; eventData: TData; runtime?: TRuntime }) => boolean
  resolve: (
    output: TOutput,
    context: { rawText: string; eventData: TData; runtime?: TRuntime },
  ) => TraderWorkflowStageTransitionRoute<TData>
}

export function buildTraderSkipResult(reason: string, rawText: string): TraderRunnerResult {
  return {
    status: 'skip',
    reason,
    rawText,
  }
}

export function resolveEmptyMarketScanReason(
  _strategy: TraderStrategy,
  summary: string,
  evaluations: Array<{ source: string; symbol: string; reason: string }>,
): string {
  const normalizedSummary = summary.trim()
  if (normalizedSummary) return normalizedSummary
  const evaluationSummary = evaluations
    .map((evaluation) => `${evaluation.symbol} on ${evaluation.source}: ${evaluation.reason.trim()}`)
    .filter((entry) => !entry.endsWith(':'))
    .join(' ')
  if (evaluationSummary) return evaluationSummary
  return 'No tradable candidate found.'
}

export function interpretTraderWorkflowStageTransitions<TOutput, TData>(
  stage: TraderWorkflowStage,
  output: TOutput,
  context: { rawText: string; eventData: TData; runtime?: Record<string, unknown> | undefined },
  rules: readonly TraderWorkflowStageTransitionRule<TOutput, TData, Record<string, unknown> | undefined>[],
): TraderWorkflowStageTransitionRoute<TData> {
  const rule = rules.find((entry) => entry.when(output, context))
  if (!rule) {
    throw new Error(`No trader workflow transition matched stage ${stage}.`)
  }
  return rule.resolve(output, context)
}

export function resolveTraderWorkflowStageRoute<TOutput extends Record<string, unknown>, TData>(
  definition: Pick<TraderWorkflowStageDefinition<TOutput, TData, Record<string, unknown> | undefined>, 'stage' | 'transitions'>,
  result: { output: TOutput; rawText: string; eventData: TData; runtime?: Record<string, unknown> | undefined },
): TraderWorkflowStageTransitionRoute<TData> | null {
  if (!definition.transitions) return null
  return interpretTraderWorkflowStageTransitions(
    definition.stage,
    result.output,
    {
      rawText: result.rawText,
      eventData: result.eventData,
      runtime: result.runtime,
    },
    definition.transitions,
  )
}

export function resolveRiskSnapshotFailureRoute(
  thesisOutput: TraderTradeThesisResult,
  warnings: string[],
  rawText: string,
): TraderWorkflowStageTransitionRoute<Record<string, unknown>> {
  const error = warnings.join(' ')
  return {
    status: 'failed',
    decision: 'stop-run',
    eventData: {
      source: thesisOutput.source,
      symbol: thesisOutput.symbol,
      error,
    },
    runnerResult: buildTraderSkipResult(error, rawText),
  }
}

interface TraderTradePlanRouteRuntime {
  hardRiskBlock?: string
}

interface TraderTradeExecuteScriptResult {
  source: string
  symbol: string
  commitMessage: string
  outcome: {
    rationale: string
    filledCount: number
    pendingCount: number
    rejectedCount: number
    actionsTaken?: string[]
  }
  result: unknown
}

interface TraderWorkflowStageFactoryContext {
  strategy: TraderStrategy
  publicStrategy: TraderStrategy
  toPublicSnapshot: (snapshot: TraderPreflightSnapshot) => TraderPreflightSnapshot
  toPublicSource: <T extends { source: string }>(value: T) => T
  toInternalSource: <T extends { source: string }>(value: T) => T
  replaceInternalStrings: <T>(value: T) => T
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

function validateTradePlanOutput(thesis: { source: string; symbol: string; chosenScenario: string }, output: TraderTradePlanReadyResult | TraderTradePlanResult) {
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

export function createTraderWorkflowAgentStageDefinitions(ctx: TraderWorkflowStageFactoryContext) {
  return {
    marketScan(preflightSnapshot: TraderPreflightSnapshot): TraderWorkflowAgentStageDefinition<TraderMarketScanResult, TraderMarketScanResult> {
      const publicSnapshot = ctx.toPublicSnapshot(preflightSnapshot)
      return {
        stage: 'market-scan',
        skillId: TRADER_SKILLS.marketScan,
        task: buildMarketScanTask(ctx.publicStrategy, publicSnapshot),
        schema: traderMarketScanSchema,
        context: {
          strategy: ctx.publicStrategy,
          snapshot: publicSnapshot,
        },
        requiredScriptCalls: buildMarketScanRequiredScriptCalls(ctx.publicStrategy),
        transform: (output) => ({
          ...ctx.replaceInternalStrings(output),
          candidates: output.candidates.map((candidate) => ctx.replaceInternalStrings(ctx.toInternalSource(candidate))),
          evaluations: output.evaluations.map((evaluation) => ctx.replaceInternalStrings(ctx.toInternalSource(evaluation))),
        }),
        validate: (output) => validateMarketScanOutput(ctx.strategy, output),
        transitions: [
          {
            when: (output) => output.candidates.length === 0,
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'stop-run',
              eventData: routeContext.eventData,
              runnerResult: buildTraderSkipResult(
                resolveEmptyMarketScanReason(ctx.strategy, output.summary, output.evaluations),
                routeContext.rawText,
              ),
            }),
          },
          {
            when: () => true,
            resolve: (_output, routeContext) => ({
              status: 'completed',
              decision: 'advance',
              eventData: routeContext.eventData,
            }),
          },
        ],
      }
    },

    tradeThesis(
      candidate: TraderMarketCandidate,
      preflightSnapshot: TraderPreflightSnapshot,
    ): TraderWorkflowAgentStageDefinition<TraderTradeThesisResult, TraderTradeThesisResult> {
      const publicCandidate = ctx.toPublicSource(candidate)
      const publicPreflightSnapshot = ctx.toPublicSnapshot(preflightSnapshot)
      return {
        stage: 'trade-thesis',
        skillId: TRADER_SKILLS.tradeThesis,
        task: buildTradeThesisTask(ctx.publicStrategy, publicCandidate, publicPreflightSnapshot),
        schema: traderTradeThesisSchema,
        context: {
          strategy: ctx.publicStrategy,
          candidate: publicCandidate,
          snapshot: publicPreflightSnapshot,
        },
        requiredScriptCalls: buildTradeThesisRequiredScriptCalls(ctx.publicStrategy, publicCandidate),
        transform: (output) => ctx.replaceInternalStrings(ctx.toInternalSource(output)),
        validate: (output) => validateThesisOutput(candidate, output),
        onError: (error) => ({
          source: candidate.source,
          symbol: candidate.symbol,
          error: error instanceof Error ? error.message : String(error),
        }),
        transitions: [
          {
            when: (output) => output.status === 'no_trade',
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'next-candidate',
              eventData: routeContext.eventData,
              runnerResult: buildTraderSkipResult(output.rationale, routeContext.rawText),
              brainUpdates: output.contextNotes,
            }),
          },
          {
            when: () => true,
            resolve: (_output, routeContext) => ({
              status: 'completed',
              decision: 'advance',
              eventData: routeContext.eventData,
            }),
          },
        ],
      }
    },

    riskCheck(
      thesisOutput: TraderTradeThesisResult,
      riskSnapshot: TraderPreflightSnapshot,
    ): TraderWorkflowAgentStageDefinition<TraderRiskCheckResult, TraderRiskCheckResult> {
      const publicRiskSnapshot = ctx.toPublicSnapshot(riskSnapshot)
      const publicThesis = ctx.toPublicSource(thesisOutput)
      return {
        stage: 'risk-check',
        skillId: TRADER_SKILLS.riskCheck,
        task: buildRiskCheckTask(ctx.publicStrategy, publicThesis, publicRiskSnapshot),
        schema: traderRiskCheckSchema,
        context: {
          strategy: ctx.publicStrategy,
          thesis: publicThesis,
          snapshot: publicRiskSnapshot,
        },
        requiredScriptCalls: buildSingleSourceRequiredScriptCall(publicThesis.source, 'risk-check'),
        transform: (output) => ctx.replaceInternalStrings(ctx.toInternalSource(output)),
        validate: (output) => validateRiskOutput(thesisOutput, output),
        onError: (error) => ({
          source: thesisOutput.source,
          symbol: thesisOutput.symbol,
          error: error instanceof Error ? error.message : String(error),
        }),
        transitions: [
          {
            when: (output) => output.verdict !== 'pass',
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'next-candidate',
              eventData: routeContext.eventData,
              runnerResult: buildTraderSkipResult(output.rationale, routeContext.rawText),
            }),
          },
          {
            when: () => true,
            resolve: (_output, routeContext) => ({
              status: 'completed',
              decision: 'advance',
              eventData: routeContext.eventData,
            }),
          },
        ],
      }
    },

    tradePlan(
      thesisOutput: TraderTradeThesisResult,
      riskOutput: TraderRiskCheckResult,
    ): TraderWorkflowAgentStageDefinition<TraderTradePlanResult, TraderTradePlanResult> {
      const publicThesis = ctx.toPublicSource(thesisOutput)
      const publicRisk = ctx.toPublicSource(riskOutput)
      return {
        stage: 'trade-plan',
        skillId: TRADER_SKILLS.tradePlan,
        task: buildTradePlanTask(ctx.publicStrategy, publicThesis, publicRisk),
        schema: traderTradePlanSchema,
        context: {
          strategy: ctx.publicStrategy,
          thesis: publicThesis,
          risk: publicRisk,
        },
        requiredScriptCalls: buildSingleSourceRequiredScriptCall(publicThesis.source, 'trade-plan'),
        transform: (output) => ctx.replaceInternalStrings(ctx.toInternalSource(output)),
        validate: (output) => validateTradePlanOutput(thesisOutput, output),
        onError: (error) => ({
          source: thesisOutput.source,
          symbol: thesisOutput.symbol,
          error: error instanceof Error ? error.message : String(error),
        }),
        transitions: [
          {
            when: (_output, routeContext) => typeof (routeContext.runtime as TraderTradePlanRouteRuntime | undefined)?.hardRiskBlock === 'string',
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'next-candidate',
              eventData: {
                ...routeContext.eventData,
                rationale: (routeContext.runtime as TraderTradePlanRouteRuntime).hardRiskBlock,
                gate: 'hard-risk-budget',
              },
              runnerResult: buildTraderSkipResult((routeContext.runtime as TraderTradePlanRouteRuntime).hardRiskBlock!, routeContext.rawText),
              brainUpdates: 'brainUpdate' in output && typeof output.brainUpdate === 'string'
                ? [output.brainUpdate]
                : [],
            }),
          },
          {
            when: (output) => output.status !== 'plan_ready' || output.orders.length === 0,
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'next-candidate',
              eventData: routeContext.eventData,
              runnerResult: buildTraderSkipResult(output.rationale, routeContext.rawText),
              brainUpdates: [output.brainUpdate],
            }),
          },
          {
            when: () => true,
            resolve: (_output, routeContext) => ({
              status: 'completed',
              decision: 'advance',
              eventData: routeContext.eventData,
            }),
          },
        ],
      }
    },

    tradeExecute(
      planOutput: TraderTradePlanReadyResult,
    ): TraderWorkflowAgentStageDefinition<TraderTradeExecuteResult, TraderTradeExecuteResult> {
      const publicPlan = ctx.toPublicSource(planOutput)
      return {
        stage: 'trade-execute',
        skillId: TRADER_SKILLS.tradeExecute,
        task: buildTradeExecuteTask(ctx.publicStrategy, publicPlan),
        schema: traderTradeExecuteSchema,
        context: {
          strategy: ctx.publicStrategy,
          plan: publicPlan,
        },
        transform: (output) => ctx.replaceInternalStrings(ctx.toInternalSource(output)),
        validate: (output) => validateTradeExecuteOutput(planOutput, output),
        onError: (error) => ({
          source: planOutput.source,
          symbol: planOutput.symbol,
          error: error instanceof Error ? error.message : String(error),
        }),
        transitions: [
          {
            when: (output) => output.status !== 'execute',
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'next-candidate',
              eventData: routeContext.eventData,
              runnerResult: buildTraderSkipResult(output.rationale, routeContext.rawText),
              brainUpdates: [output.brainUpdate],
            }),
          },
          {
            when: () => true,
            resolve: (_output, routeContext) => ({
              status: 'completed',
              decision: 'advance',
              eventData: routeContext.eventData,
            }),
          },
        ],
      }
    },

    tradeExecuteScript(): TraderWorkflowStageDefinition<TraderTradeExecuteScriptResult> {
      return {
        stage: 'trade-execute-script',
        transitions: [
          {
            when: (output) => output.outcome.rejectedCount > 0 && output.outcome.filledCount === 0 && output.outcome.pendingCount === 0,
            resolve: (output, routeContext) => ({
              status: 'skipped',
              decision: 'stop-run',
              eventData: routeContext.eventData,
              runnerResult: buildTraderSkipResult(output.outcome.rationale, routeContext.rawText),
              completeWorkflow: true,
            }),
          },
          {
            when: () => true,
            resolve: (_output, routeContext) => ({
              status: 'completed',
              decision: 'advance',
              eventData: routeContext.eventData,
              completeWorkflow: true,
            }),
          },
        ],
      }
    },
  }
}

export { traderTradeReviewSchema }
