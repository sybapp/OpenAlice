import type { OhlcvData } from '@/domains/technical-analysis/indicator-kit/index'
import { detectFairValueGaps } from './analyzer/fvg'
import { detectLiquidityPools } from './analyzer/liquidity'
import { detectBosChoch, detectStructure, summarizeIctDecisionWindow } from './analyzer/structure'
import { detectSwings } from './analyzer/swings'
import type {
  IctSmcAnalyzeOutput,
  IctSmcDecisionWindow,
  IctSmcFairValueGap,
  IctSmcLiquidityPool,
  IctSmcStructureSummary,
  IctSmcSwing,
} from './types'

export type IctSmcAnalyzeOutputV2 = {
  version: 2
  symbol: string
  timeframe: string
  lookbackBars: number
  recentBars: number
  core: {
    bias: 'bullish' | 'bearish' | 'neutral'
    confidence: number
    regime: 'trend' | 'range' | 'transition' | 'unknown'
    keyLevels: Array<{ kind: 'swing-high' | 'swing-low' | 'eq-highs' | 'eq-lows' | 'fvg-top' | 'fvg-bottom'; price: number; note?: string }>
    scenarios: Array<{
      name: 'primary' | 'alternate' | 'no-trade'
      thesis: string
      triggers: string[]
      invalidation: string[]
      objectives: string[]
    }>
    warnings: Array<{ code: string; message: string }>
  }
  detailed?: {
    swings: IctSmcSwing[]
    liquidity: IctSmcLiquidityPool[]
    fvgs: IctSmcFairValueGap[]
    structure: IctSmcStructureSummary
    decisionWindow: IctSmcDecisionWindow
    debug?: Record<string, unknown>
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function buildRegime(params: { structure: IctSmcStructureSummary; decisionWindow: IctSmcDecisionWindow }): IctSmcAnalyzeOutputV2['core']['regime'] {
  const { structure, decisionWindow } = params

  const hasBreaks = (structure.bos.length + structure.choch.length) > 0
  const isDisplacement = structure.displacement.active
  const isRangeLike = decisionWindow.summary.notes.some((n) => n.toLowerCase().includes('range'))

  if (isDisplacement && hasBreaks) return 'transition'
  if (hasBreaks) return 'trend'
  if (isRangeLike) return 'range'
  return 'unknown'
}

function buildConfidence(params: {
  bias: 'bullish' | 'bearish' | 'neutral'
  structure: IctSmcStructureSummary
  liquidity: IctSmcLiquidityPool[]
  fvgs: IctSmcFairValueGap[]
}): number {
  const { bias, structure, liquidity, fvgs } = params

  let score = 0.35

  const breaks = structure.bos.length + structure.choch.length
  score += Math.min(0.25, breaks * 0.05)

  if (structure.displacement.active) score += 0.15
  if (structure.mitigation.active) score += 0.08

  const swept = liquidity.filter((l) => l.swept).length
  score += Math.min(0.1, swept * 0.03)

  const unfilled = fvgs.filter((g) => !g.filled).length
  score += Math.min(0.07, unfilled * 0.02)

  if (bias === 'neutral') score -= 0.12

  return clamp01(score)
}

function buildKeyLevels(params: {
  swings: IctSmcSwing[]
  liquidity: IctSmcLiquidityPool[]
  fvgs: IctSmcFairValueGap[]
  structure: IctSmcStructureSummary
}): IctSmcAnalyzeOutputV2['core']['keyLevels'] {
  const { swings, liquidity, fvgs, structure } = params

  const levels: IctSmcAnalyzeOutputV2['core']['keyLevels'] = []

  if (structure.latestSwingHigh) levels.push({ kind: 'swing-high', price: structure.latestSwingHigh.price, note: 'Latest swing high' })
  if (structure.latestSwingLow) levels.push({ kind: 'swing-low', price: structure.latestSwingLow.price, note: 'Latest swing low' })

  // 最接近当前结构的 EQH/EQL
  const eqHigh = liquidity.find((l) => l.kind === 'equal-highs')
  const eqLow = liquidity.find((l) => l.kind === 'equal-lows')
  if (eqHigh) levels.push({ kind: 'eq-highs', price: eqHigh.price, note: eqHigh.swept ? 'Equal highs (swept)' : 'Equal highs' })
  if (eqLow) levels.push({ kind: 'eq-lows', price: eqLow.price, note: eqLow.swept ? 'Equal lows (swept)' : 'Equal lows' })

  // 最近的未填补 FVG
  const lastUnfilled = [...fvgs].reverse().find((g) => !g.filled)
  if (lastUnfilled) {
    levels.push({ kind: 'fvg-top', price: lastUnfilled.top, note: `${lastUnfilled.side} FVG top` })
    levels.push({ kind: 'fvg-bottom', price: lastUnfilled.bottom, note: `${lastUnfilled.side} FVG bottom` })
  }

  // 去重（同价位可能重复）
  const seen = new Set<string>()
  return levels.filter((l) => {
    const key = `${l.kind}:${l.price}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildWarnings(params: {
  bias: 'bullish' | 'bearish' | 'neutral'
  structure: IctSmcStructureSummary
  decisionWindow: IctSmcDecisionWindow
}): Array<{ code: string; message: string }> {
  const { bias, structure, decisionWindow } = params

  const warnings: Array<{ code: string; message: string }> = []
  if (bias === 'neutral') warnings.push({ code: 'NEUTRAL_BIAS', message: 'Structure bias is neutral; expect chop or transition.' })
  if (!structure.displacement.active) warnings.push({ code: 'NO_DISPLACEMENT', message: 'No active displacement; signals may be weaker.' })
  if (decisionWindow.summary.liquiditySweep === 'none') warnings.push({ code: 'NO_SWEEP', message: 'No clear liquidity sweep in the decision window.' })
  if (decisionWindow.summary.barCount < 5) warnings.push({ code: 'LOW_SAMPLE', message: 'Decision window is small; reduce confidence.' })
  return warnings
}

function buildScenarios(params: {
  bias: 'bullish' | 'bearish' | 'neutral'
  regime: IctSmcAnalyzeOutputV2['core']['regime']
  keyLevels: IctSmcAnalyzeOutputV2['core']['keyLevels']
  warnings: Array<{ code: string; message: string }>
}): IctSmcAnalyzeOutputV2['core']['scenarios'] {
  const { bias, regime, keyLevels, warnings } = params

  const get = (kind: IctSmcAnalyzeOutputV2['core']['keyLevels'][number]['kind']) =>
    keyLevels.find((l) => l.kind === kind)?.price

  const sh = get('swing-high')
  const sl = get('swing-low')
  const fvgTop = get('fvg-top')
  const fvgBottom = get('fvg-bottom')

  const warningCodes = warnings.map((w) => w.code).join(', ')
  const w = warningCodes ? `Warnings: ${warningCodes}.` : ''

  if (bias === 'neutral') {
    return [{
      name: 'no-trade',
      thesis: `Bias is neutral / mixed; wait for BOS+displacement alignment. ${w}`.trim(),
      triggers: [],
      invalidation: [],
      objectives: [],
    }]
  }

  const primary = {
    name: 'primary' as const,
    thesis: `Trade with ${bias} bias in ${regime} regime. ${w}`.trim(),
    triggers: [
      bias === 'bullish'
        ? (sh != null ? `Break above swing-high ${sh} (BOS) with displacement.` : 'Bullish BOS with displacement.')
        : (sl != null ? `Break below swing-low ${sl} (BOS) with displacement.` : 'Bearish BOS with displacement.'),
      bias === 'bullish'
        ? (fvgBottom != null ? `Retrace into bullish FVG (down to ~${fvgBottom}) then hold.` : 'Retrace into FVG / mitigation block then hold.')
        : (fvgTop != null ? `Retrace into bearish FVG (up to ~${fvgTop}) then reject.` : 'Retrace into FVG / mitigation block then reject.'),
    ],
    invalidation: [
      bias === 'bullish'
        ? (sl != null ? `Close below swing-low ${sl}.` : 'Close below latest swing-low.')
        : (sh != null ? `Close above swing-high ${sh}.` : 'Close above latest swing-high.'),
    ],
    objectives: [
      bias === 'bullish'
        ? (sh != null ? `Target liquidity above ${sh}.` : 'Target next buy-side liquidity.')
        : (sl != null ? `Target liquidity below ${sl}.` : 'Target next sell-side liquidity.'),
    ],
  }

  const alternate = {
    name: 'alternate' as const,
    thesis: `If ${bias} continuation fails, look for CHOCH and reversal back into range.`,
    triggers: [
      'CHOCH against the prevailing bias after a sweep.',
    ],
    invalidation: [
      'Continuation BOS resumes in original direction.',
    ],
    objectives: [
      'Mean reversion to equilibrium / opposite liquidity pool.',
    ],
  }

  return [primary, alternate]
}

export function analyzeIctSmc(params: {
  symbol: string
  timeframe: string
  lookbackBars: number
  recentBars: number
  swingLookback: number
  bars: OhlcvData[]
}): IctSmcAnalyzeOutputV2 {
  const { symbol, timeframe, lookbackBars, recentBars, swingLookback, bars } = params

  const swings = detectSwings(bars, swingLookback)
  const liquidity = detectLiquidityPools(swings, bars)
  const fvgs = detectFairValueGaps(bars)
  const bosChoch = detectBosChoch(swings, bars)
  const structureBase = detectStructure({ swings, bars, fvgs, liquidity })

  const structure: IctSmcStructureSummary = {
    ...structureBase,
    bos: bosChoch.bos,
    choch: bosChoch.choch,
    latestSwingHigh: bosChoch.latestSwingHigh,
    latestSwingLow: bosChoch.latestSwingLow,
    bias: bosChoch.bias,
  }

  const decisionWindow = summarizeIctDecisionWindow({
    tf: timeframe,
    bars: bars.slice(-recentBars),
    liquidity,
    structure,
  })

  const bias = structure.bias
  const keyLevels = buildKeyLevels({ swings, liquidity, fvgs, structure })
  const regime = buildRegime({ structure, decisionWindow })
  const warnings = buildWarnings({ bias, structure, decisionWindow })
  const confidence = buildConfidence({ bias, structure, liquidity, fvgs })
  const scenarios = buildScenarios({ bias, regime, keyLevels, warnings })

  const detailed: IctSmcAnalyzeOutputV2['detailed'] = {
    swings,
    liquidity,
    fvgs,
    structure,
    decisionWindow,
  }

  return {
    version: 2,
    symbol,
    timeframe,
    lookbackBars,
    recentBars,
    core: {
      bias,
      confidence,
      regime,
      keyLevels,
      scenarios,
      warnings,
    },
    detailed,
  }
}

// 兼容：如果外部仍引用旧 IctSmcAnalyzeOutput，可通过 detailed 层拿到相同字段。
export type { IctSmcAnalyzeOutput }
