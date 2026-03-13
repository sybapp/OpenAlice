import { createEventLog } from '../../../core/event-log.js'
import { SessionStore } from '../../../core/session.js'
import { setSessionSkill } from '../../../core/skills/session-skill.js'
import { wireAccountTrading } from '../factory.js'
import { HistoricalMarketReplay } from './HistoricalMarketReplay.js'
import { BacktestAccount } from './BacktestAccount.js'
import { BacktestRunner } from './BacktestRunner.js'
import { ScriptedBacktestStrategyDriver } from './strategy-scripted.js'
import { AIBacktestStrategyDriver } from './strategy-ai.js'
import { normalizeBacktestRunId } from './storage.js'
import {
  createBacktestRunId,
  type BacktestRunManager,
  type BacktestRunManagerOptions,
  type BacktestRunConfig,
  type BacktestRunManifest,
  type BacktestRunRecord,
} from './types.js'
import type { Operation } from '../git/types.js'
import { getTraderStrategy } from '../../../task/trader/strategy.js'
import { buildTraderSystemPrompt } from '../../../task/trader/prompt.js'

export function createBacktestRunManager(options: BacktestRunManagerOptions): BacktestRunManager {
  const running = new Map<string, Promise<BacktestRunManifest>>()

  async function executeRun(config: BacktestRunConfig): Promise<BacktestRunManifest> {
    const runId = normalizeBacktestRunId(config.runId ?? createBacktestRunId())
    const storage = options.storage
    const accountId = config.accountId ?? `${runId}-paper`
    const accountLabel = config.accountLabel ?? 'Backtest Paper'
    const mode = config.strategy.mode
    const artifactDir = storage.getRunPaths(runId).runDir
    const session = mode === 'ai' ? new SessionStore(`backtest/${runId}`) : null

    const manifest: BacktestRunManifest = {
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
    }

    await storage.createRun(manifest)

    const eventLog = await createEventLog({ logPath: storage.getRunPaths(runId).eventLogPath })

    try {
      await storage.updateManifest(runId, {
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const replay = new HistoricalMarketReplay({
        bars: config.bars,
        startTime: config.startTime,
      })
      await replay.init()

      const account = new BacktestAccount({
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
      if (traderStrategy && session) {
        await setSessionSkill(session, 'trader-auto')
      }

      const strategyDriver = strategyConfig.mode === 'scripted'
        ? new ScriptedBacktestStrategyDriver({
            strategy: ({ step }) => strategyConfig.decisions.find((entry) => entry.step === step)?.operations ?? [],
          })
        : new AIBacktestStrategyDriver({
            eventLog,
            ask: async (context) => {
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
      await eventLog.close()
      await account.close()
      return finalManifest
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await storage.updateManifest(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: message,
      })
      try {
        await eventLog.append('backtest.run.failed', { runId, error: message })
      } catch {
        // ignore secondary logging failures
      }
      await eventLog.close()
      throw err
    }
  }

  return {
    async startRun(config) {
      const runId = normalizeBacktestRunId(config.runId ?? createBacktestRunId())
      const promise = executeRun({ ...config, runId })
        .finally(() => {
          running.delete(runId)
        })
      running.set(runId, promise)
      return { runId }
    },

    async waitForRun(runId) {
      const current = running.get(runId)
      if (current) return current
      const manifest = await options.storage.getManifest(runId)
      if (!manifest) throw new Error(`Backtest run not found: ${runId}`)
      return manifest
    },

    async listRuns() {
      return options.storage.listRuns()
    },

    async getRun(runId) {
      const manifest = await options.storage.getManifest(runId)
      if (!manifest) return null
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
