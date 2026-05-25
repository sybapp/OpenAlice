import type { SignalEngineConfig } from '../../core/config.js'
import type { TradeSetupService } from '../trading/setup-service.js'
import type { CreateSignalTradeSetupInput } from '../trading/setup-types.js'
import type {
  RiskTemplate,
  SignalEngineAutoStageEntry,
  SignalEngineAutoStageResult,
  SignalEngineRun,
  SignalEngineSignal,
} from './types.js'

export interface AutoStageSignalRunInput {
  run: SignalEngineRun
  config: Pick<SignalEngineConfig, 'autoStage'>
  riskTemplate: RiskTemplate
  tradeSetupService: Pick<TradeSetupService, 'createFromSignal' | 'stageSetup'>
  resolveAliceId: (input: {
    source: string
    symbol: string
    asset: SignalEngineRun['asset']
  }) => Promise<string | null>
}

export async function autoStageSignalRun(input: AutoStageSignalRunInput): Promise<SignalEngineRun> {
  const autoStage = await stageSignals(input)
  return {
    ...input.run,
    autoStageStatus: autoStage.status,
    ...(autoStage.error ? { autoStageError: autoStage.error } : {}),
    autoStage,
  }
}

async function stageSignals(input: AutoStageSignalRunInput): Promise<SignalEngineAutoStageResult> {
  const { run, config } = input
  if (!config.autoStage.enabled) {
    return skipped('disabled', false, config.autoStage.defaultUtaId, 'auto-stage disabled')
  }
  if (!config.autoStage.defaultUtaId) {
    return skipped('skipped', true, undefined, 'signalEngine.autoStage.defaultUtaId is required')
  }
  if (run.signals.length === 0) {
    return skipped('skipped', true, config.autoStage.defaultUtaId, 'no signals to auto-stage')
  }

  const entries: SignalEngineAutoStageEntry[] = []
  for (const signal of run.signals) {
    try {
      const aliceId = await input.resolveAliceId({
        source: config.autoStage.defaultUtaId,
        symbol: run.symbol,
        asset: run.asset,
      })
      if (!aliceId) {
        entries.push({ signalId: signal.id, status: 'failed', error: `No tradeable contract found for ${config.autoStage.defaultUtaId}:${run.symbol}` })
        continue
      }

      const createInput = toTradeSetupInput(run, signal, config.autoStage.defaultUtaId, aliceId, input.riskTemplate)
      if (!createInput) {
        entries.push({ signalId: signal.id, status: 'failed', error: 'signal is not tradeable' })
        continue
      }

      const created = await input.tradeSetupService.createFromSignal(createInput)
      if (!created.ok) {
        entries.push({ signalId: signal.id, status: 'failed', error: created.error })
        continue
      }
      const staged = await input.tradeSetupService.stageSetup(created.setup.setupId)
      entries.push(staged.ok
        ? { signalId: signal.id, status: 'staged', setupId: staged.setup.setupId }
        : { signalId: signal.id, status: 'failed', setupId: created.setup.setupId, error: staged.error })
    } catch (error) {
      entries.push({ signalId: signal.id, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  const staged = entries.filter((entry) => entry.status === 'staged').length
  const failed = entries.length - staged
  const error = failed > 0 ? entries.find((entry) => entry.error)?.error ?? 'auto-stage failed' : undefined
  return {
    status: staged === entries.length ? 'staged' : staged > 0 ? 'partial' : 'failed',
    enabled: true,
    defaultUtaId: config.autoStage.defaultUtaId,
    attempted: entries.length,
    staged,
    failed,
    entries,
    ...(error ? { error } : {}),
  }
}

function skipped(
  status: 'disabled' | 'skipped',
  enabled: boolean,
  defaultUtaId: string | undefined,
  error: string,
): SignalEngineAutoStageResult {
  return {
    status,
    enabled,
    ...(defaultUtaId ? { defaultUtaId } : {}),
    attempted: 0,
    staged: 0,
    failed: 0,
    entries: [],
    error,
  }
}

function toTradeSetupInput(
  run: SignalEngineRun,
  signal: SignalEngineSignal,
  utaId: string,
  aliceId: string,
  riskTemplate: RiskTemplate,
): CreateSignalTradeSetupInput | null {
  if (signal.order.orderType !== 'LMT') return null
  if (!signal.order.lmtPrice || !signal.order.stopLoss?.price) return null
  if (!riskTemplate.totalQuantity && !riskTemplate.cashQty) return null

  return {
    signalRunId: run.runId,
    signalId: signal.id,
    engineVersion: run.engineVersion,
    strategyId: run.strategyId,
    strategyVersion: run.strategyVersion,
    dataFingerprint: run.dataFingerprint,
    closedBarTime: signal.closedBarTime,
    sourceHash: signal.sourceHash,
    canonicalPayloadHash: signal.canonicalPayloadHash,
    riskTemplateId: run.riskTemplateId,
    riskTemplateVersion: run.riskTemplateVersion,
    source: utaId,
    aliceId,
    symbol: run.symbol,
    asset: run.asset,
    interval: run.interval,
    direction: signal.direction,
    action: signal.order.action,
    ...(riskTemplate.totalQuantity ? { totalQuantity: riskTemplate.totalQuantity } : {}),
    ...(riskTemplate.cashQty ? { cashQty: riskTemplate.cashQty } : {}),
    lmtPrice: signal.order.lmtPrice,
    ...(signal.order.takeProfit?.price ? { takeProfitPrice: signal.order.takeProfit.price } : {}),
    stopLossPrice: signal.order.stopLoss.price,
    ...(signal.order.stopLoss.limitPrice ? { stopLossLimitPrice: signal.order.stopLoss.limitPrice } : {}),
    thesis: signal.message,
    invalidation: `Stop loss ${signal.order.stopLoss.price} from signal ${signal.id}`,
    riskNotes: `Auto-staged from signal engine run ${run.runId}; requires manual push.`,
    signals: [{ id: signal.id, label: signal.label, message: signal.message }],
  }
}
