import { describe, expect, it } from 'vitest'
import { getSkillScript, listSkillScripts } from './script-registry.js'

describe('skill script registry', () => {
  it('defaults crypto analysis scripts to asset=crypto when the model omits it', () => {
    const brooks = getSkillScript('analysis-brooks')
    const ict = getSkillScript('analysis-ict-smc')
    const indicator = getSkillScript('analysis-indicator')

    expect(brooks?.inputSchema.parse({ symbol: 'BTC/USDT:USDT' })).toMatchObject({
      asset: 'crypto',
      symbol: 'BTC/USDT:USDT',
    })
    expect(ict?.inputSchema.parse({ symbol: 'BTC/USDT:USDT' })).toMatchObject({
      asset: 'crypto',
      symbol: 'BTC/USDT:USDT',
    })
    expect(indicator?.inputSchema.parse({ formula: 'close("BTC/USDT:USDT", "5m")' })).toMatchObject({
      asset: 'crypto',
      formula: 'close("BTC/USDT:USDT", "5m")',
    })
  })

  it('publishes an explicit brooks input guide for the skill-loop prompt', () => {
    const brooks = getSkillScript('analysis-brooks')
    const listed = listSkillScripts(['analysis-brooks'])[0]

    expect(brooks?.inputGuide).toContain('timeframes must be a named object')
    expect(listed?.inputGuide).toContain('"timeframes":{"context":"1h","structure":"15m","execution":"5m"}')
  })

  it('rejects array-style brooks timeframes so contract drift fails fast', () => {
    const brooks = getSkillScript('analysis-brooks')

    expect(() => brooks?.inputSchema.parse({
      symbol: 'BTC/USDT:USDT',
      timeframes: ['1h', '15m', '5m'],
    })).toThrow()
  })
})
