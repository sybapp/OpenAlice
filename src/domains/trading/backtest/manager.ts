import { createEventLog } from '../../../core/event-log.js'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionStore } from '../../../core/session.js'
import { setSessionSkill } from '../../../skills/session-skill.js'
import type { Engine } from '../../../core/engine.js'
import {
  traderMarketScanSchema,
  traderRiskCheckSchema,
  traderTradeExecuteSchema,
  traderTradePlanSchema,
  traderTradeThesisSchema,
} from '../../../skills/completion-schemas.js'
import { wireAccountTrading } from '../factory.js'
import { HistoricalMarketReplay } from './HistoricalMarketReplay.js'
import { BacktestAccount } from './BacktestAccount.js'
import { BacktestRunner } from './BacktestRunner.js'
import { ScriptedBacktestStrategyDriver } from './strategy-scripted.js'
import { AIBacktestStrategyDriver } from './strategy-ai.js'
import { normalizeBacktestRunId } from './storage.js'
import { parseBacktestRunConfig } from './validation.js'
import {
  createBacktestRunId,
  type BacktestRunManager,
  type BacktestRunManagerOptions,
  type BacktestRunConfig,
  type BacktestRunManifest,
  type BacktestRunRecord,
  type BacktestStrategyContext,
} from './types.js'
import type { Operation } from '../git/types.js'
import { getTraderStrategy } from '../../../jobs/strategies/strategy.js'
import {
  buildMarketScanPrompt,
  buildRiskCheckPrompt,
  buildTradeExecutePrompt,
  buildTradePlanPrompt,
  buildTradeThesisPrompt,
  buildTraderSystemPrompt,
} from '../../../jobs/strategies/prompt.js'
import type { TraderStrategy } from '../../../jobs/strategies/types.js'

const TRADER_SKILLS = {
  marketScan: 'trader-market-scan',
  tradeThesis: 'trader-trade-thesis',
  riskCheck: 'trader-risk-check',
  tradePlan: 'trader-trade-plan',
  tradeExecute: 'trader-trade-execute',
} as const

const INVALID_RUN_CLAIM_STALE_MS = 5_000

export function createBacktestRunManager(options: BacktestRunManagerOptions): BacktestRunManager {
  const running = new Map<string, Promise<BacktestRunManifest>>()

  async function resolveVisibleManifest(runId: string): Promise<BacktestRunManifest> {
    const manifest = await options.storage.getManifest(runId)
    if (!manifest) throw new Error(`Backtest run not found: ${runId}`)
    if (manifest.status === 'completed' || manifest.status === 'failed') return manifest
    if (await hasActiveRunClaim(join(options.storage.getRunPaths(runId).runDir, '.run.lock'))) {
      return manifest
    }

    const patch: Partial<BacktestRunManifest> = {
      status: 'failed',
      completedAt: manifest.completedAt ?? new Date().toISOString(),
      error: manifest.error ?? `Backtest run became orphaned while still ${manifest.status}.`,
    }

    try {
      return await options.storage.updateManifest(runId, patch)
    } catch {
      return { ...manifest, ...patch }
    }
  }

  function prepareRun(config: BacktestRunConfig): {
    runId: string
    session: SessionStore | null
    manifest: BacktestRunManifest
  } {
    const runId = normalizeBacktestRunId(config.runId ?? createBacktestRunId())
    const storage = options.storage
    const accountId = config.accountId ?? `${runId}-paper`
    const accountLabel = config.accountLabel ?? 'Backtest Paper'
    const mode = config.strategy.mode
    const artifactDir = storage.getRunPaths(runId).runDir
    const session = mode === 'ai' ? new SessionStore(`backtest/${runId}`) : null

    return {
      runId,
      session,
      manifest: {
        runId,
        status: 'queued',
        mode,
        createdAt: new Date().toISOString(),
        sessionId: session?.id,
        artifactDir,
        barCount: config.bars.length,
        currentStep: 0,
        accountId,
        accountLabel,
        initialCash: config.initialCash,
        startTime: config.startTime,
        guards: config.guards ?? [],
      },
    }
  }

  async function executeRun(
    config: BacktestRunConfig,
    prepared: { runId: string; session: SessionStore | null },
  ): Promise<BacktestRunManifest> {
    const { runId, session } = prepared
    const storage = options.storage
    const accountId = config.accountId ?? `${runId}-paper`
    const accountLabel = config.accountLabel ?? 'Backtest Paper'
    let eventLog: Awaited<ReturnType<typeof createEventLog>> | null = null
    let account: BacktestAccount | null = null

    try {
      eventLog = await createEventLog({ logPath: storage.getRunPaths(runId).eventLogPath })

      await storage.updateManifest(runId, {
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const replay = new HistoricalMarketReplay({
        bars: config.bars,
        startTime: config.startTime,
      })
      await replay.init()

      account = new BacktestAccount({
        id: accountId,
        label: accountLabel,
        replay,
        initialCash: config.initialCash,
      })
      await account.init()

      const setup = wireAccountTrading(account, {
        guards: config.guards,
        onCommit: async (state) => {
          await storage.writeGitState(runId, state)
        },
      })

      const strategyConfig = config.strategy
      const traderStrategy = strategyConfig.mode === 'ai' && strategyConfig.strategyId
        ? await getTraderStrategy(strategyConfig.strategyId)
        : null
      const strategyDriver = strategyConfig.mode === 'scripted'
        ? new ScriptedBacktestStrategyDriver({
            strategy: ({ step }) => strategyConfig.decisions.find((entry) => entry.step === step)?.operations ?? [],
          })
        : new AIBacktestStrategyDriver({
            eventLog,
            ask: async (context) => {
              if (traderStrategy && session) {
                return runTraderBacktestDecision({
                  engine: options.engine,
                  session,
                  strategy: traderStrategy,
                  context,
                  replayBars: config.bars,
                  accountSource: traderStrategy.sources[0] ?? accountId,
                })
              }
              const prompt = buildAIBacktestPrompt(strategyConfig, context, traderStrategy)
              const result = await options.engine.askWithSession(prompt, session!, {
                systemPrompt: traderStrategy ? buildTraderSystemPrompt(traderStrategy) : strategyConfig.systemPrompt,
                maxHistoryEntries: strategyConfig.maxHistoryEntries,
                historyPreamble: 'The following is the prior backtest decision history for this run.',
              })
              return parseAIBacktestResponse(result.text)
            },
          })

      const runner = new BacktestRunner({
        runId,
        replay,
        account,
        git: setup.git,
        getGitState: setup.getGitState,
        eventLog,
        strategyDriver,
        onStep: async (snapshot) => {
          await Promise.all([
            storage.appendEquityPoint(runId, {
              step: snapshot.step,
              ts: snapshot.ts,
              equity: snapshot.equity,
              realizedPnL: snapshot.realizedPnL,
              unrealizedPnL: snapshot.unrealizedPnL,
            }),
            storage.updateManifest(runId, { currentStep: snapshot.step }),
          ])
        },
      })

      const summary = await runner.run()
      await storage.writeSummary(runId, summary)
      const finalManifest = await storage.updateManifest(runId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      })
      return finalManifest
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        await storage.updateManifest(runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: message,
        })
      } catch {
        // ignore secondary manifest persistence failures
      }
      try {
        await eventLog?.append('backtest.run.failed', { runId, error: message })
      } catch {
      }
      throw err
    } finally {
      await Promise.allSettled([
        eventLog?.close() ?? Promise.resolve(),
        account?.close() ?? Promise.resolve(),
      ])
    }
  }

  return {
    async startRun(config) {
      const validated = parseBacktestRunConfig(config)
      const prepared = prepareRun(validated)
      const { runId, manifest } = prepared
      if (running.has(runId)) {
        throw new Error(`Backtest run already in progress: ${runId}`)
      }
      await options.storage.claimRunId(runId)
      try {
        await options.storage.createRun(manifest)
      } catch (err) {
        await options.storage.releaseRunId(runId)
        throw err
      }

      const promise = executeRun({ ...validated, runId }, prepared)
        .finally(() => {
          running.delete(runId)
          return options.storage.releaseRunId(runId)
        })
      running.set(runId, promise)
      return { runId }
    },

    async waitForRun(runId) {
      const current = running.get(runId)
      if (current) {
        try {
          return await current
        } catch (err) {
          const manifest = await resolveVisibleManifest(runId)
          if (manifest?.status === 'failed' || manifest?.status === 'completed') return manifest
          throw err
        }
      }
      return resolveVisibleManifest(runId)
    },

    async listRuns() {
      const manifests = await options.storage.listRuns()
      const resolved = await Promise.all(manifests.map(async (manifest) => {
        if (manifest.status === 'completed' || manifest.status === 'failed') return manifest
        return resolveVisibleManifest(manifest.runId)
      }))
      return resolved.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    },

    async getRun(runId) {
      const existing = await options.storage.getManifest(runId)
      if (!existing) return null
      const manifest = existing.status === 'completed' || existing.status === 'failed'
        ? existing
        : await resolveVisibleManifest(runId)
      const summary = await options.storage.readSummary(runId) ?? undefined
      const record: BacktestRunRecord = { manifest, summary }
      return record
    },

    async getSummary(runId) {
      return options.storage.readSummary(runId)
    },

    async getEquityCurve(runId, opts) {
      return options.storage.readEquityCurve(runId, opts)
    },

    async getEvents(runId, opts) {
      return options.storage.readEventEntries(runId, opts)
    },

    async getGitState(runId) {
      return options.storage.readGitState(runId)
    },

    async getSessionEntries(runId) {
      return options.storage.readSessionEntries(runId)
    },
  }
}

async function hasActiveRunClaim(claimPath: string): Promise<boolean> {
  const metadata = await readClaimMetadata(claimPath)
  if (metadata?.pid) {
    return isProcessAlive(metadata.pid)
  }

  try {
    await stat(claimPath)
  } catch (err) {
    if (isENOENT(err)) return false
    throw err
  }

  return !(await isInvalidClaimStale(claimPath))
}

async function readClaimMetadata(claimPath: string): Promise<{ pid?: number } | null> {
  const raw = await readFile(claimPath, 'utf-8').catch((err: unknown) => {
    if (isENOENT(err)) return null
    throw err
  })
  if (!raw) return null

  try {
    return JSON.parse(raw) as { pid?: number }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ESRCH')
  }
}

async function isInvalidClaimStale(claimPath: string): Promise<boolean> {
  try {
    const info = await stat(claimPath)
    return Date.now() - info.mtimeMs >= INVALID_RUN_CLAIM_STALE_MS
  } catch (err) {
    if (isENOENT(err)) return false
    throw err
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function buildAIBacktestPrompt(
  strategyConfig: { prompt: string; strategyId?: string },
  context: { runId: string; step: number; timestamp: string; accountId: string; bars: unknown; account?: unknown; positions?: unknown; orders?: unknown },
  traderStrategy: Awaited<ReturnType<typeof getTraderStrategy>>,
): string {
  return [
    traderStrategy
      ? `Backtest the strategy "${traderStrategy.id}" (${traderStrategy.label}) using the structured context below. Follow the configured sources, universe, timeframes, and risk budget as guidance.`
      : strategyConfig.prompt,
    '',
    'Respond with JSON only using this shape:',
    '{"text":"short explanation","operations":[{"action":"placeOrder","params":{...}}]}',
    '',
    traderStrategy ? `Strategy:\n${JSON.stringify(traderStrategy, null, 2)}\n` : '',
    'Context:',
    JSON.stringify(context, null, 2),
  ].join('\n')
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) return fenced[1].trim()
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

function buildBacktestSkillContext(params: {
  strategy: TraderStrategy
  skillId: string
  allowedScripts: string[]
  source: string
  timestamp: string
  bars: BacktestRunConfig['bars']
  context: BacktestStrategyContext
  stageContext?: Record<string, unknown>
}) {
  return {
    strategy: params.strategy,
    stage: params.skillId,
    allowedScripts: params.allowedScripts,
    backtest: {
      mode: 'backtest' as const,
      asset: params.strategy.universe.asset,
      source: params.source,
      currentTimestamp: params.timestamp,
      bars: params.bars,
      account: params.context.account,
      positions: params.context.positions,
      orders: params.context.orders,
      marketClock: { isOpen: true },
    },
    ...params.stageContext,
  }
}

async function runTraderBacktestStage<T>(params: {
  engine: Engine
  session: SessionStore
  skillId: string
  prompt: string
  strategy: TraderStrategy
  schema: { parse: (value: unknown) => T }
  allowedScripts: string[]
  backtest: {
    source: string
    timestamp: string
    bars: BacktestRunConfig['bars']
    context: BacktestStrategyContext
  }
  stageContext?: Record<string, unknown>
}) {
  await setSessionSkill(params.session, params.skillId)
  const result = await params.engine.askWithSession(params.prompt, params.session, {
    systemPrompt: buildTraderSystemPrompt(params.strategy),
    historyPreamble: 'The following is the prior structured skill-loop history for this backtest run.',
    maxHistoryEntries: 30,
    skillContext: buildBacktestSkillContext({
      strategy: params.strategy,
      skillId: params.skillId,
      allowedScripts: params.allowedScripts,
      source: params.backtest.source,
      timestamp: params.backtest.timestamp,
      bars: params.backtest.bars,
      context: params.backtest.context,
      stageContext: params.stageContext,
    }),
  })
  const output = parseStageOutput(result.text, params.schema)
  if (!output) {
    throw new Error(`Backtest skill ${params.skillId} did not return a valid completion payload`)
  }
  return { output, rawText: result.text }
}

function buildBacktestStage(params: {
  strategy: TraderStrategy
  context: BacktestStrategyContext
  replayBars: BacktestRunConfig['bars']
  source: string
}) {
  return {
    strategy: params.strategy,
    backtest: {
      source: params.source,
      timestamp: params.context.timestamp,
      bars: params.replayBars,
      context: params.context,
    },
  }
}

function buildBacktestSnapshot(strategy: TraderStrategy, context: BacktestStrategyContext, source: string) {
  const account = context.account ?? null
  const positions = context.positions ?? []
  const orders = context.orders ?? []
  const equity = account && typeof account === 'object' && 'equity' in account && typeof account.equity === 'number'
    ? account.equity
    : 0
  const grossExposure = equity > 0
    ? positions.reduce((sum, position) => {
        const marketValue = typeof position === 'object' && position && 'marketValue' in position && typeof position.marketValue === 'number'
          ? position.marketValue
          : 0
        return sum + Math.abs(marketValue)
      }, 0) / equity * 100
    : 0

  return {
    frontalLobe: 'Backtest mode: use only historical replay context and avoid live data assumptions.',
    warnings: [],
    exposurePercent: grossExposure,
    totalPositions: positions.length,
    sourceSnapshots: [{
      source,
      account,
      positions,
      orders,
      marketClock: { isOpen: true },
    }],
  }
}

function planToBacktestOperations(plan: {
  orders: Array<Record<string, unknown>>
}): Operation[] {
  return plan.orders.map((order) => ({
    action: 'placeOrder',
    params: order,
  }))
}

async function runTraderBacktestDecision(params: {
  engine: Engine
  session: SessionStore
  strategy: TraderStrategy
  context: BacktestStrategyContext
  replayBars: BacktestRunConfig['bars']
  accountSource: string
}): Promise<{ text?: string; operations?: Operation[] }> {
  const snapshot = buildBacktestSnapshot(params.strategy, params.context, params.accountSource)
  const marketScanStage = buildBacktestStage({
    strategy: params.strategy,
    context: params.context,
    replayBars: params.replayBars,
    source: params.accountSource,
  })
  const scan = await runTraderBacktestStage({
    engine: params.engine,
    session: params.session,
    ...marketScanStage,
    skillId: TRADER_SKILLS.marketScan,
    prompt: buildMarketScanPrompt(params.strategy, snapshot),
    schema: traderMarketScanSchema,
    allowedScripts: ['trader-account-state', 'analysis-brooks', 'analysis-ict-smc'],
    stageContext: { snapshot },
  })
  const candidate = scan.output.candidates[0]
  if (!candidate) {
    return { text: scan.output.summary || 'No tradable candidate found.', operations: [] }
  }

  const symbolStage = buildBacktestStage({
    strategy: params.strategy,
    context: params.context,
    replayBars: params.replayBars,
    source: candidate.source,
  })
  const thesis = await runTraderBacktestStage({
    engine: params.engine,
    session: params.session,
    ...symbolStage,
    skillId: TRADER_SKILLS.tradeThesis,
    prompt: buildTradeThesisPrompt(params.strategy, candidate, snapshot),
    schema: traderTradeThesisSchema,
    allowedScripts: ['trader-account-state', 'analysis-brooks', 'analysis-ict-smc', 'analysis-indicator'],
    stageContext: { candidate, snapshot },
  })
  if (thesis.output.status === 'no_trade') {
    return { text: thesis.output.rationale, operations: [] }
  }

  const risk = await runTraderBacktestStage({
    engine: params.engine,
    session: params.session,
    ...symbolStage,
    skillId: TRADER_SKILLS.riskCheck,
    prompt: buildRiskCheckPrompt(params.strategy, thesis.output, snapshot),
    schema: traderRiskCheckSchema,
    allowedScripts: ['trader-account-state'],
    stageContext: { thesis: thesis.output, snapshot },
  })
  if (risk.output.verdict !== 'pass') {
    return { text: risk.output.rationale, operations: [] }
  }

  const plan = await runTraderBacktestStage({
    engine: params.engine,
    session: params.session,
    ...symbolStage,
    skillId: TRADER_SKILLS.tradePlan,
    prompt: buildTradePlanPrompt(params.strategy, thesis.output, risk.output),
    schema: traderTradePlanSchema,
    allowedScripts: [],
    stageContext: { thesis: thesis.output, risk: risk.output },
  })
  if (plan.output.status !== 'plan_ready' || plan.output.orders.length === 0) {
    return { text: plan.output.rationale, operations: [] }
  }

  const execute = await runTraderBacktestStage({
    engine: params.engine,
    session: params.session,
    ...symbolStage,
    skillId: TRADER_SKILLS.tradeExecute,
    prompt: buildTradeExecutePrompt(params.strategy, plan.output),
    schema: traderTradeExecuteSchema,
    allowedScripts: [],
    stageContext: { plan: plan.output },
  })
  if (execute.output.status !== 'execute') {
    return { text: execute.output.rationale, operations: [] }
  }

  return {
    text: execute.output.rationale,
    operations: planToBacktestOperations(plan.output),
  }
}

function parseAIBacktestResponse(text: string): { text?: string; operations?: Operation[] } {
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed) as { text?: string; operations?: Operation[] }
    return {
      text: parsed.text,
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    }
  } catch {
    return { text: trimmed, operations: [] }
  }
}
