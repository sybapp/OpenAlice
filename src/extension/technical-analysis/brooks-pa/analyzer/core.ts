import type {
  BrooksDecisionWindowSummary,
  BrooksPaAnalyzeOutput,
  RecentBar,
  Timeframes,
} from '../types'

export type BrooksPaAnalyzeOutputV2 = {
  version: 2
  symbol: string
  timeframes: { context: string; structure: string; execution: string }
  lookbackBars: number
  recentBars: number
  core: {
    regimeByTf: Record<string, {
      marketType: 'trend' | 'range' | 'breakout' | 'channel' | 'unknown'
      direction: 'long' | 'short' | 'neutral'
      confidence: number
    }>
    dominantRegime: 'trend' | 'range' | 'breakout' | 'channel' | 'unknown'
    bias: 'long' | 'short' | 'neutral'
    confidence: number

    keyLevels: Array<{
      tf: string
      kind: 'support' | 'resistance' | 'close' | 'swing-high' | 'swing-low'
      price: number
      note?: string
    }>

    scenarios: Array<{
      name: 'primary' | 'alternate' | 'no-trade'
      thesis: string
      triggers: string[]
      invalidation: string[]
      objectives: string[]
    }>

    noTrade: Array<{ code: string; message: string }>
    warnings: Array<{ code: string; message: string }>
  }
  detailed?: {
    indexing: { oldest: number; latest: number }
    marketTypeByTf: Record<string, { marketType: string; confidence: number }>
    levels: Array<{ tf: string; kind: string; price: number; note?: string }>
    patterns: Array<{ tf: string; name: string; note?: string }>
    tradeCandidates: Array<{ tf: string; direction: 'long' | 'short'; rationale: string }>
    recentBars: RecentBar[]
    keyBars: Array<{ tf: string; index: number; date: string; note: string }>
    decisionWindow: BrooksDecisionWindowSummary
    debug?: Record<string, unknown>
  }
}

function pickDominantRegime(regimeByTf: BrooksPaAnalyzeOutputV2['core']['regimeByTf']): BrooksPaAnalyzeOutputV2['core']['dominantRegime'] {
  const entries = Object.entries(regimeByTf)
  if (entries.length === 0) return 'unknown'

  const ranked = entries
    .slice()
    .sort((a, b) => (b[1].confidence ?? 0) - (a[1].confidence ?? 0))

  return ranked[0]?.[1].marketType ?? 'unknown'
}

function pickBias(regimeByTf: BrooksPaAnalyzeOutputV2['core']['regimeByTf']): BrooksPaAnalyzeOutputV2['core']['bias'] {
  const votes: Record<'long' | 'short' | 'neutral', number> = { long: 0, short: 0, neutral: 0 }
  for (const v of Object.values(regimeByTf)) {
    votes[v.direction] += v.confidence ?? 0
  }

  if (votes.long === 0 && votes.short === 0) return 'neutral'
  if (Math.abs(votes.long - votes.short) < 0.15) return 'neutral'
  return votes.long > votes.short ? 'long' : 'short'
}

function computeOverallConfidence(regimeByTf: BrooksPaAnalyzeOutputV2['core']['regimeByTf']): number {
  const values = Object.values(regimeByTf)
  if (values.length === 0) return 0.2

  // 结构一致性：同向越一致，置信度越高
  const longScore = values.filter((v) => v.direction === 'long').reduce((a, b) => a + b.confidence, 0)
  const shortScore = values.filter((v) => v.direction === 'short').reduce((a, b) => a + b.confidence, 0)
  const neutralScore = values.filter((v) => v.direction === 'neutral').reduce((a, b) => a + b.confidence, 0)

  const total = longScore + shortScore + neutralScore
  if (total <= 0) return 0.2

  const dominance = Math.max(longScore, shortScore, neutralScore) / total
  const avg = values.reduce((a, b) => a + b.confidence, 0) / values.length

  return Math.max(0, Math.min(1, 0.55 * avg + 0.45 * dominance))
}

function buildScenarios(params: {
  bias: 'long' | 'short' | 'neutral'
  timeframes: Timeframes
  detailed: BrooksPaAnalyzeOutput
  noTrade: Array<{ code: string; message: string }>
  warnings: Array<{ code: string; message: string }>
}): BrooksPaAnalyzeOutputV2['core']['scenarios'] {
  const { bias, timeframes, detailed, noTrade, warnings } = params

  if (noTrade.length) {
    return [{
      name: 'no-trade',
      thesis: `No-trade due to: ${noTrade.map((r) => r.code).join(', ')}.`,
      triggers: [],
      invalidation: [],
      objectives: [],
    }]
  }

  const levelsByTf = (tf: string, kind: string) =>
    detailed.levels
      .filter((l) => l.tf === tf && l.kind === kind)
      .map((l) => l.price)

  const execSupport = levelsByTf(timeframes.execution, 'support')[0]
  const execResistance = levelsByTf(timeframes.execution, 'resistance')[0]

  const commonWarnings = warnings.length ? `Warnings: ${warnings.map((w) => w.code).join(', ')}.` : ''

  const primary = bias === 'neutral'
    ? {
      name: 'primary' as const,
      thesis: `Market is mixed/neutral across timeframes. Prefer waiting for clearer breakout or strong reversal. ${commonWarnings}`.trim(),
      triggers: [
        execResistance != null ? `Break and hold above ${execResistance} on ${timeframes.execution}.` : 'Break and hold above recent execution range high.',
        execSupport != null ? `Or breakdown below ${execSupport} on ${timeframes.execution}.` : 'Or breakdown below recent execution range low.',
      ],
      invalidation: [
        'Immediate failed breakout with strong opposite close back into range.',
      ],
      objectives: [
        'First measured move / test of prior swing.',
      ],
    }
    : {
      name: 'primary' as const,
      thesis: `Align with ${bias} bias unless follow-through fails. ${commonWarnings}`.trim(),
      triggers: [
        bias === 'long'
          ? (execResistance != null ? `Bull breakout above ${execResistance} with follow-through.` : 'Bull breakout with follow-through on execution TF.')
          : (execSupport != null ? `Bear breakout below ${execSupport} with follow-through.` : 'Bear breakout with follow-through on execution TF.'),
      ],
      invalidation: [
        'Failed breakout / strong opposite close that negates follow-through.',
      ],
      objectives: [
        'Test of recent swing / measured move based on decision window.',
      ],
    }

  const alternate = {
    name: 'alternate' as const,
    thesis: bias === 'neutral'
      ? 'Fade extremes inside range only with clear rejection bar and tight risk.'
      : `Alternate: if ${bias} thesis fails, look for reversal back into range / failed breakout trade.`,
    triggers: [
      'Clear failed breakout signature (breakout then strong close back inside).',
    ],
    invalidation: [
      'Follow-through resumes in original direction.',
    ],
    objectives: [
      'Back to mid-range / opposite side of decision window.',
    ],
  }

  return [primary, alternate]
}

export function buildBrooksCoreFromDetailed(
  detailed: BrooksPaAnalyzeOutput,
  ctx: { symbol: string; timeframes: Timeframes },
): BrooksPaAnalyzeOutputV2['core'] {
  const regimeByTf: BrooksPaAnalyzeOutputV2['core']['regimeByTf'] = {}

  for (const [tf, v] of Object.entries(detailed.marketTypeByTf ?? {})) {
    // 旧输出没有 direction，这里用 tradeCandidates（或 neutral）补齐
    const candidate = detailed.tradeCandidates.find((c) => c.tf === tf)
    regimeByTf[tf] = {
      marketType: (v.marketType as any) ?? 'unknown',
      direction: candidate?.direction ?? 'neutral',
      confidence: v.confidence ?? 0.2,
    }
  }

  const dominantRegime = pickDominantRegime(regimeByTf)
  const bias = pickBias(regimeByTf)
  const confidence = computeOverallConfidence(regimeByTf)

  const noTrade = (detailed.noTrade ?? []).map((r) => ({ code: r.code, message: r.message }))

  const warnings: Array<{ code: string; message: string }> = []
  const execPattern = detailed.patterns?.filter((p) => p.tf === ctx.timeframes.execution) ?? []
  if (execPattern.some((p) => p.name === 'range')) warnings.push({ code: 'RANGE', message: 'Execution timeframe is in a range/overlap state.' })
  if (execPattern.some((p) => p.name === 'failed-breakout')) warnings.push({ code: 'FAILED_BREAKOUT', message: 'Recent failed breakout suggests choppy conditions.' })
  if (execPattern.some((p) => p.name === 'follow-through') === false && dominantRegime === 'breakout') {
    warnings.push({ code: 'NO_FOLLOW_THROUGH', message: 'Breakout detected but follow-through is not strong.' })
  }

  const keyLevels = detailed.levels.map((l) => ({
    tf: l.tf,
    kind: (l.kind as any),
    price: l.price,
    note: l.note,
  }))

  const scenarios = buildScenarios({
    bias,
    timeframes: ctx.timeframes,
    detailed,
    noTrade,
    warnings,
  })

  return {
    regimeByTf,
    dominantRegime,
    bias,
    confidence,
    keyLevels,
    scenarios,
    noTrade,
    warnings,
  }
}
