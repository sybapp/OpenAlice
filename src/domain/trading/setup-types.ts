export type TradeSetupStatus = 'draft' | 'committed' | 'rejected' | 'failed'

export type TradeSetupDirection = 'bullish' | 'bearish'

export interface TradeSetupOrderDraft {
  source: string
  aliceId: string
  symbol?: string
  action: 'BUY' | 'SELL'
  orderType: 'MKT' | 'LMT' | 'STP' | 'STP LMT' | 'TRAIL' | 'TRAIL LIMIT' | 'MOC'
  totalQuantity?: string
  cashQty?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  tif?: 'DAY' | 'GTC' | 'IOC' | 'FOK' | 'OPG' | 'GTD'
  goodTillDate?: string
  outsideRth?: boolean
  takeProfit?: { price: string }
  stopLoss?: { price: string; limitPrice?: string }
}

export interface MarketDataAlertTradeSetupSource {
  type: 'market_data_alert'
  alertRunId: string
}

export interface SignalEngineTradeSetupSource {
  type: 'signal_engine'
  signalRunId: string
  signalId: string
  engineVersion: string
  strategyId: string
  strategyVersion: string
  dataFingerprint: string
  closedBarTime: string
}

export type TradeSetupSource = MarketDataAlertTradeSetupSource | SignalEngineTradeSetupSource

export interface TradeSetupProvenance {
  sourceHash: string
  canonicalPayloadHash: string
  riskTemplateId: string
  riskTemplateVersion: string
  accountEligibility: {
    allowedModes: Array<'simulator' | 'paper'>
    resolvedMode?: string
    accountId?: string
  }
}

export interface TradeSetup {
  setupId: string
  status: TradeSetupStatus
  createdAt: string
  updatedAt: string
  source: TradeSetupSource
  asset?: string
  symbol: string
  interval?: string
  direction: TradeSetupDirection
  thesis: string
  invalidation: string
  riskNotes?: string
  signals: Array<{ id: string; label: string; message: string }>
  order: TradeSetupOrderDraft
  provenance?: TradeSetupProvenance
  commitHash?: string
  commitMessage?: string
  error?: string
}

export interface CreateTradeSetupInput {
  alertRunId: string
  source: string
  aliceId: string
  action?: 'BUY' | 'SELL'
  orderType?: TradeSetupOrderDraft['orderType']
  totalQuantity?: string
  cashQty?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  tif?: TradeSetupOrderDraft['tif']
  goodTillDate?: string
  outsideRth?: boolean
  takeProfitPrice?: string
  stopLossPrice?: string
  stopLossLimitPrice?: string
  thesis?: string
  invalidation: string
  riskNotes?: string
}

export interface CreateSignalTradeSetupInput {
  signalRunId: string
  signalId: string
  engineVersion: string
  strategyId: string
  strategyVersion: string
  dataFingerprint: string
  closedBarTime: string
  sourceHash: string
  canonicalPayloadHash: string
  riskTemplateId: string
  riskTemplateVersion: string
  source: string
  aliceId: string
  symbol: string
  asset?: string
  interval?: string
  direction: TradeSetupDirection
  action?: 'BUY' | 'SELL'
  totalQuantity?: string
  cashQty?: string
  lmtPrice: string
  tif?: TradeSetupOrderDraft['tif']
  goodTillDate?: string
  outsideRth?: boolean
  takeProfitPrice?: string
  stopLossPrice: string
  stopLossLimitPrice?: string
  thesis: string
  invalidation: string
  riskNotes?: string
  signals?: Array<{ id: string; label: string; message: string }>
}

export interface ListTradeSetupsOptions {
  limit?: number
  status?: TradeSetupStatus
  symbol?: string
  source?: string
}
