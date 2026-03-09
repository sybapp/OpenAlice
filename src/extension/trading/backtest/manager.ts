import { resolve } from 'node:path'
import { createEventLog } from '../../../core/event-log.js'
import { SessionStore } from '../../../core/session.js'
import type { Engine } from '../../../core/engine.js'
import { wireAccountTrading } from '../factory.js'
import { HistoricalMarketReplay } from './HistoricalMarketReplay.js'
import { BacktestAccount } from './BacktestAccount.js'
import { BacktestRunner } from './BacktestRunner.js'
import { ScriptedBacktestStrategyDriver } from './strategy-scripted.js'
import { AIBacktestStrategyDriver } from './strategy-ai.js'
import {
  createBacktestRunId,
  type BacktestRunManager,
  type BacktestRunManagerOptions,
  type BacktestRunConfig,
  type BacktestRunManifest,
  type BacktestRunRecord,
} from './types.js'

export function createBacktestRunManager(options: BacktestRunManagerOptions): BacktestRunManager {
  const running = new Map<string, Promise<BacktestRunManifest>>()

  async function executeRun(config: BacktestRunConfig): Promise<BacktestRunManifest> {
    const runId = config.runId ?? createBacktestRunId()
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

      const strategyDriver = mode === 'scripted'
        ? new ScriptedBacktestStrategyDriver({
            strategy: ({ step }) => config.strategy.decisions.find((entry) => entry.step === step)?.operations ?? [],
          })
        : new AIBacktestStrategyDriver({
            session: session!,
            eventLog,
            ask: async (context) => {
              const prompt = buildAIBacktestPrompt(config.strategy.prompt, context)
              const result = await options.engine.askWithSession(prompt, session!, {
                systemPrompt: config.strategy.systemPrompt,
                maxHistoryEntries: config.strategy.maxHistoryEntries,
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
      const runId = config.runId ?? createBacktestRunId()
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

function buildAIBacktestPrompt(basePrompt: string, context: { runId: string; step: number; timestamp: string; accountId: string; bars: unknown; account?: unknown; positions?: unknown; orders?: unknown }): string {
  return [
    basePrompt,
    '',
    'Respond with JSON only using this shape:',
    '{"text":"short explanation","operations":[{"action":"placeOrder","params":{...}}]}',
    '',
    'Context:',
    JSON.stringify(context, null, 2),
  ].join('\n')
}

function parseAIBacktestResponse(text: string): { text?: string; operations?: Array<{ action: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder' | 'syncOrders'; params: Record<string, unknown> }> } {
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed) as { text?: string; operations?: Array<{ action: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder' | 'syncOrders'; params: Record<string, unknown> }> }
    return {
      text: parsed.text,
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    }
  } catch {
    return { text: trimmed, operations: [] }
  }
}
