import type { OhlcvData } from '@/extension/indicator-kit/index'
import type { BrooksMidpointAvoidance, BrooksPaAnalyzeOutput, RecentBar, Timeframes } from '../types'
import { classifyBarType, summarizeBarFeatures, checkMidpointAvoidance } from './features'

export function analyzeBrooksPa(params: {
  symbol: string
  timeframes: Timeframes
  lookbackBars: number
  recentBars: number
  midpointAvoidance: BrooksMidpointAvoidance
  dataByTf: Record<string, OhlcvData[]>
}): BrooksPaAnalyzeOutput {
  const { timeframes, recentBars, midpointAvoidance, dataByTf } = params

  const execTf = timeframes.execution
  const execBars = dataByTf[execTf] ?? []

  const latestIndex = Math.max(0, execBars.length - 1)

  const recent = execBars
    .slice(-recentBars)
    .map((b, i, arr): RecentBar => {
      const index = execBars.length - arr.length + i
      return {
        index,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        barType: classifyBarType(b),
        features: summarizeBarFeatures(b),
      }
    })

  const noTrade = checkMidpointAvoidance({ bars: execBars, avoidance: midpointAvoidance })

  // Placeholder deterministic output scaffolding (marketType/levels/patterns/candidates)
  const marketTypeByTf: BrooksPaAnalyzeOutput['marketTypeByTf'] = {
    [timeframes.context]: { marketType: 'unknown', confidence: 0.2 },
    [timeframes.structure]: { marketType: 'unknown', confidence: 0.2 },
    [timeframes.execution]: { marketType: 'unknown', confidence: 0.2 },
  }

  return {
    indexing: { oldest: 0, latest: latestIndex },
    marketTypeByTf,
    levels: [],
    patterns: [],
    tradeCandidates: [],
    noTrade,
    recentBars: recent,
    keyBars: [],
  }
}
