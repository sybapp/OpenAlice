import type { TradeSetupStore } from './setup-store.js'
import type { CreateSignalTradeSetupInput, CreateTradeSetupInput, TradeSetup, TradeSetupDirection } from './setup-types.js'
import type { UTAConfig } from '../../core/config.js'
import { readUTAsConfig } from '../../core/config.js'
import type { UTAManagerSDK } from '../../services/uta-client/index.js'
import type { MarketDataAlertRunRecord } from '../market-data/ohlcv/types.js'
import { MarketDataAlertRunStore } from '../market-data/ohlcv/run-store.js'

const SIGNAL_ALLOWED_ACCOUNT_MODES = ['simulator', 'paper'] as const

export interface TradeSetupServiceDeps {
  setupStore: TradeSetupStore
  alertRunStore?: MarketDataAlertRunStore
  utaManager: UTAManagerSDK
  readUTAsConfig?: () => Promise<UTAConfig[]>
}

export class TradeSetupService {
  private readonly alertRunStore: MarketDataAlertRunStore

  constructor(private readonly deps: TradeSetupServiceDeps) {
    this.alertRunStore = deps.alertRunStore ?? new MarketDataAlertRunStore()
  }

  async createFromAlertRun(input: CreateTradeSetupInput): Promise<{ ok: true; setup: TradeSetup } | { ok: false; error: string }> {
    const alertRun = (await this.alertRunStore.list({ limit: 500 })).entries.find((run) => run.runId === input.alertRunId)
    if (!alertRun) return { ok: false, error: `Unknown alert run: ${input.alertRunId}` }
    if (alertRun.status !== 'triggered') return { ok: false, error: `Alert run is not triggerable: ${alertRun.status}` }
    if (!input.invalidation.trim()) return { ok: false, error: 'invalidation is required' }
    if (!input.stopLossPrice && !input.invalidation.trim()) return { ok: false, error: 'stopLossPrice or invalidation is required' }
    if (!input.totalQuantity && !input.cashQty) return { ok: false, error: 'totalQuantity or cashQty is required' }

    const direction = inferDirection(alertRun, input.action)
    const action = input.action ?? (direction === 'bullish' ? 'BUY' : 'SELL')
    const symbol = alertRun.symbol ?? input.aliceId.split('|').at(-1) ?? ''
    const setup = await this.deps.setupStore.create({
      source: { type: 'market_data_alert', alertRunId: input.alertRunId },
      asset: alertRun.asset,
      symbol,
      interval: alertRun.interval,
      direction,
      thesis: input.thesis?.trim() || buildThesis(alertRun),
      invalidation: input.invalidation.trim(),
      ...(input.riskNotes?.trim() ? { riskNotes: input.riskNotes.trim() } : {}),
      signals: alertRun.signals.map((signal) => ({ id: signal.id, label: signal.label, message: signal.message })),
      order: {
        source: input.source,
        aliceId: input.aliceId,
        symbol,
        action,
        orderType: input.orderType ?? (input.lmtPrice ? 'LMT' : 'MKT'),
        ...(input.totalQuantity ? { totalQuantity: input.totalQuantity } : {}),
        ...(input.cashQty ? { cashQty: input.cashQty } : {}),
        ...(input.lmtPrice ? { lmtPrice: input.lmtPrice } : {}),
        ...(input.auxPrice ? { auxPrice: input.auxPrice } : {}),
        ...(input.trailStopPrice ? { trailStopPrice: input.trailStopPrice } : {}),
        ...(input.trailingPercent ? { trailingPercent: input.trailingPercent } : {}),
        ...(input.tif ? { tif: input.tif } : {}),
        ...(input.goodTillDate ? { goodTillDate: input.goodTillDate } : {}),
        ...(input.outsideRth == null ? {} : { outsideRth: input.outsideRth }),
        ...(input.takeProfitPrice ? { takeProfit: { price: input.takeProfitPrice } } : {}),
        ...(input.stopLossPrice ? { stopLoss: { price: input.stopLossPrice, ...(input.stopLossLimitPrice ? { limitPrice: input.stopLossLimitPrice } : {}) } } : {}),
      },
    })
    return { ok: true, setup }
  }

  async createFromSignal(input: CreateSignalTradeSetupInput): Promise<{ ok: true; setup: TradeSetup } | { ok: false; error: string }> {
    const validationError = validateSignalInput(input)
    if (validationError) return { ok: false, error: validationError }

    const accountEligibility = await this.resolveSignalAccountEligibility(input.source)
    const setup = await this.deps.setupStore.create({
      source: {
        type: 'signal_engine',
        signalRunId: input.signalRunId,
        signalId: input.signalId,
        engineVersion: input.engineVersion,
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        dataFingerprint: input.dataFingerprint,
        closedBarTime: input.closedBarTime,
      },
      asset: input.asset,
      symbol: input.symbol,
      interval: input.interval,
      direction: input.direction,
      thesis: input.thesis.trim(),
      invalidation: input.invalidation.trim(),
      ...(input.riskNotes?.trim() ? { riskNotes: input.riskNotes.trim() } : {}),
      signals: input.signals ?? [{
        id: input.signalId,
        label: input.strategyId,
        message: input.thesis.trim(),
      }],
      order: {
        source: input.source,
        aliceId: input.aliceId,
        symbol: input.symbol,
        action: input.action ?? (input.direction === 'bullish' ? 'BUY' : 'SELL'),
        orderType: 'LMT',
        ...(input.totalQuantity ? { totalQuantity: input.totalQuantity } : {}),
        ...(input.cashQty ? { cashQty: input.cashQty } : {}),
        lmtPrice: input.lmtPrice,
        ...(input.tif ? { tif: input.tif } : {}),
        ...(input.goodTillDate ? { goodTillDate: input.goodTillDate } : {}),
        ...(input.outsideRth == null ? {} : { outsideRth: input.outsideRth }),
        ...(input.takeProfitPrice ? { takeProfit: { price: input.takeProfitPrice } } : {}),
        stopLoss: { price: input.stopLossPrice, ...(input.stopLossLimitPrice ? { limitPrice: input.stopLossLimitPrice } : {}) },
      },
      provenance: {
        sourceHash: input.sourceHash,
        canonicalPayloadHash: input.canonicalPayloadHash,
        riskTemplateId: input.riskTemplateId,
        riskTemplateVersion: input.riskTemplateVersion,
        accountEligibility,
      },
    })
    return { ok: true, setup }
  }

  async stageSetup(setupId: string): Promise<{ ok: true; setup: TradeSetup } | { ok: false; error: string; setup?: TradeSetup }> {
    const setup = await this.deps.setupStore.get(setupId)
    if (!setup) return { ok: false, error: `Unknown setup: ${setupId}` }
    if (setup.status !== 'draft') return { ok: false, error: `Setup is already ${setup.status}`, setup }
    if (!setup.order.stopLoss && !setup.invalidation.trim()) return { ok: false, error: 'stopLoss or invalidation is required', setup }
    if (setup.source.type === 'signal_engine') {
      const validationError = await this.validateSignalStage(setup)
      if (validationError) return { ok: false, error: validationError, setup }
    }

    try {
      const uta = await this.deps.utaManager.resolveOne(setup.order.source)
      const { source: _source, ...stageParams } = setup.order
      await uta.stagePlaceOrder(stageParams)
      const message = buildCommitMessage(setup)
      const commit = await uta.commit(message)
      const updated = await this.deps.setupStore.update(setupId, {
        status: 'committed',
        commitHash: commit.hash,
        commitMessage: message,
        error: undefined,
      })
      return { ok: true, setup: updated ?? setup }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const updated = await this.deps.setupStore.update(setupId, { status: 'failed', error: message })
      return { ok: false, error: message, setup: updated ?? setup }
    }
  }

  async rejectSetup(setupId: string, reason?: string): Promise<{ ok: true; setup: TradeSetup } | { ok: false; error: string }> {
    const setup = await this.deps.setupStore.update(setupId, {
      status: 'rejected',
      ...(reason?.trim() ? { error: reason.trim() } : {}),
    })
    if (!setup) return { ok: false, error: `Unknown setup: ${setupId}` }
    return { ok: true, setup }
  }

  private async validateSignalStage(setup: TradeSetup): Promise<string | null> {
    if (setup.order.orderType === 'MKT') return 'Signal setup cannot stage MKT orders'
    if (setup.order.orderType !== 'LMT') return 'Signal setup requires LMT order'
    if (!setup.order.lmtPrice) return 'Signal setup requires lmtPrice'
    if (!setup.order.stopLoss?.price) return 'Signal setup requires stopLoss.price'
    const hasTotalQuantity = setup.order.totalQuantity != null
    const hasCashQty = setup.order.cashQty != null
    if (hasTotalQuantity === hasCashQty) return 'Signal setup requires exactly one of totalQuantity or cashQty'

    const accountEligibility = await this.resolveSignalAccountEligibility(setup.order.source)
    if (!accountEligibility.resolvedMode) return `Signal setup account is unknown: ${setup.order.source}`
    if (!SIGNAL_ALLOWED_ACCOUNT_MODES.includes(accountEligibility.resolvedMode as 'simulator' | 'paper')) {
      return `Signal setup account mode is not allowed: ${accountEligibility.resolvedMode}`
    }
    return null
  }

  private async resolveSignalAccountEligibility(source: string) {
    const accounts = await (this.deps.readUTAsConfig ?? readUTAsConfig)()
    const account = accounts.find((uta) => uta.id === source)
    return {
      allowedModes: [...SIGNAL_ALLOWED_ACCOUNT_MODES],
      ...(account ? { resolvedMode: resolveAccountMode(account), accountId: account.id } : {}),
    }
  }
}

function inferDirection(alertRun: MarketDataAlertRunRecord, action?: 'BUY' | 'SELL'): TradeSetupDirection {
  if (action) return action === 'BUY' ? 'bullish' : 'bearish'
  const directional = alertRun.signals.find((signal) => signal.direction)
  return directional?.direction === 'bearish' ? 'bearish' : 'bullish'
}

function buildThesis(alertRun: MarketDataAlertRunRecord): string {
  const signals = alertRun.signals.slice(0, 3).map((signal) => signal.message).join('; ')
  return `${alertRun.symbol ?? 'Symbol'} ${alertRun.interval ?? ''} alert: ${signals || alertRun.summary}`.trim()
}

function buildCommitMessage(setup: TradeSetup): string {
  const sourceLines = setup.source.type === 'market_data_alert'
    ? `source alert_run=${setup.source.alertRunId}`
    : [
        'source signal_engine',
        `signal_run=${setup.source.signalRunId}`,
        `signal=${setup.source.signalId}`,
        `strategy=${setup.source.strategyId}@${setup.source.strategyVersion}`,
        `engine=${setup.source.engineVersion}`,
        `closed_bar=${setup.source.closedBarTime}`,
      ]
  const provenanceLine = setup.provenance
    ? `replay provenance source_hash=${setup.provenance.sourceHash} canonical_payload_hash=${setup.provenance.canonicalPayloadHash} risk_template=${setup.provenance.riskTemplateId}@${setup.provenance.riskTemplateVersion}`
    : undefined
  return [
    `setup ${setup.symbol}: ${setup.thesis}`,
    ...(Array.isArray(sourceLines) ? sourceLines : [sourceLines]),
    `invalidation: ${setup.invalidation}`,
    'requires manual push',
    provenanceLine,
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function validateSignalInput(input: CreateSignalTradeSetupInput): string | null {
  if (!input.thesis.trim()) return 'thesis is required'
  if (!input.invalidation.trim()) return 'invalidation is required'
  if (!input.lmtPrice) return 'lmtPrice is required'
  if (!input.stopLossPrice) return 'stopLossPrice is required'
  const hasTotalQuantity = input.totalQuantity != null
  const hasCashQty = input.cashQty != null
  if (hasTotalQuantity === hasCashQty) return 'Exactly one of totalQuantity or cashQty is required'
  return null
}

function resolveAccountMode(account: UTAConfig): 'simulator' | 'paper' | 'real' | 'unknown' {
  if (account.presetId === 'mock-simulator') return 'simulator'
  const text = `${account.presetId} ${JSON.stringify(account.presetConfig)}`.toLowerCase()
  if (text.includes('paper') || text.includes('sandbox') || text.includes('demo')) return 'paper'
  return account.presetId ? 'real' : 'unknown'
}
