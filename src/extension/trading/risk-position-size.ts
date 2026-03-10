export interface RiskPositionSizeInput {
  accountEquity: number
  entryPrice: number
  stopPrice: number
  side: 'buy' | 'sell'
  riskPercent: number
  maxExposurePercent?: number
}

export interface RiskPositionSizeResult {
  riskAmount: number
  stopDistance: number
  rawQty: number
  rawNotional: number
  qty: number
  notional: number
  cappedByExposure: boolean
  effectiveRiskAmount: number
  effectiveRiskPercent: number
}

export function calculateRiskPositionSize(input: RiskPositionSizeInput): RiskPositionSizeResult {
  const {
    accountEquity,
    entryPrice,
    stopPrice,
    side,
    riskPercent,
    maxExposurePercent = 5,
  } = input

  if (!(accountEquity > 0)) throw new Error('accountEquity must be positive')
  if (!(entryPrice > 0)) throw new Error('entryPrice must be positive')
  if (!(stopPrice > 0)) throw new Error('stopPrice must be positive')
  if (!(riskPercent > 0)) throw new Error('riskPercent must be positive')
  if (!(maxExposurePercent > 0)) throw new Error('maxExposurePercent must be positive')

  if (side === 'buy' && stopPrice >= entryPrice) {
    throw new Error('Buy stop-loss must be below entryPrice')
  }
  if (side === 'sell' && stopPrice <= entryPrice) {
    throw new Error('Sell stop-loss must be above entryPrice')
  }

  const stopDistance = Math.abs(entryPrice - stopPrice)
  if (stopDistance === 0) throw new Error('stopDistance must be greater than 0')

  const riskAmount = accountEquity * (riskPercent / 100)
  const rawQty = riskAmount / stopDistance
  const rawNotional = rawQty * entryPrice

  const maxNotional = accountEquity * (maxExposurePercent / 100)
  const cappedByExposure = rawNotional > maxNotional
  const qty = cappedByExposure ? maxNotional / entryPrice : rawQty
  const notional = qty * entryPrice
  const effectiveRiskAmount = qty * stopDistance
  const effectiveRiskPercent = (effectiveRiskAmount / accountEquity) * 100

  return {
    riskAmount,
    stopDistance,
    rawQty,
    rawNotional,
    qty,
    notional,
    cappedByExposure,
    effectiveRiskAmount,
    effectiveRiskPercent,
  }
}
