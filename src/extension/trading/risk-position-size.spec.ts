import { describe, expect, it } from 'vitest'
import { calculateRiskPositionSize } from './risk-position-size.js'

describe('calculateRiskPositionSize', () => {
  it('calculates uncapped size from risk and stop distance', () => {
    const result = calculateRiskPositionSize({
      accountEquity: 10_000,
      entryPrice: 100,
      stopPrice: 95,
      side: 'buy',
      riskPercent: 0.5,
      maxExposurePercent: 100,
    })

    expect(result.riskAmount).toBe(50)
    expect(result.stopDistance).toBe(5)
    expect(result.qty).toBe(10)
    expect(result.notional).toBe(1000)
    expect(result.cappedByExposure).toBe(false)
    expect(result.effectiveRiskAmount).toBe(50)
  })

  it('caps size by max exposure percent when raw size is too large', () => {
    const result = calculateRiskPositionSize({
      accountEquity: 10_000,
      entryPrice: 100,
      stopPrice: 99,
      side: 'buy',
      riskPercent: 1,
      maxExposurePercent: 5,
    })

    expect(result.rawQty).toBe(100)
    expect(result.qty).toBe(5)
    expect(result.notional).toBe(500)
    expect(result.cappedByExposure).toBe(true)
    expect(result.effectiveRiskAmount).toBe(5)
    expect(result.effectiveRiskPercent).toBe(0.05)
  })

  it('validates directional stop placement for shorts', () => {
    expect(() => calculateRiskPositionSize({
      accountEquity: 10_000,
      entryPrice: 100,
      stopPrice: 99,
      side: 'sell',
      riskPercent: 0.5,
    })).toThrow('Sell stop-loss must be above entryPrice')
  })
})
