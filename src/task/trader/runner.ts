import type { SessionStore } from '../../core/session.js'
import { setSessionSkill } from '../../core/skills/session-skill.js'
import { computeTradingStats } from '../../extension/trading/stats.js'
import { buildTraderPrompt, buildTraderReviewSummary, buildTraderSystemPrompt } from './prompt.js'
import { getTraderStrategy } from './strategy.js'
import type {
  TraderDecision,
  TraderReviewResult,
  TraderRunnerDeps,
  TraderRunnerResult,
  TraderStrategy,
} from './types.js'

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, value)) : 0
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence?.[1]) return fence[1].trim()

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

function parseTraderDecision(text: string, strategyId: string): TraderDecision | null {
  const candidate = extractJsonObject(text)
  if (!candidate) return null

  try {
    const parsed = JSON.parse(candidate) as Partial<TraderDecision>
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.status || !parsed.source || !parsed.symbol || !parsed.chosenScenario || !parsed.rationale) {
      return null
    }
    return {
      status: parsed.status,
      strategyId: parsed.strategyId ?? strategyId,
      source: parsed.source,
      symbol: parsed.symbol,
      chosenScenario: parsed.chosenScenario,
      rationale: parsed.rationale,
      invalidation: Array.isArray(parsed.invalidation) ? parsed.invalidation.map(String) : [],
      actionsTaken: Array.isArray(parsed.actionsTaken) ? parsed.actionsTaken.map(String) : [],
      brainUpdate: typeof parsed.brainUpdate === 'string' ? parsed.brainUpdate : '',
    }
  } catch {
    return null
  }
}

async function buildPreflightSnapshot(strategy: TraderStrategy, deps: TraderRunnerDeps) {
  const frontalLobe = deps.brain.getFrontalLobe()
  const warnings: string[] = []
  let totalExposurePercent = 0
  let totalPositions = 0

  const sourceSnapshots = await Promise.all(strategy.sources.map(async (source) => {
    const account = deps.accountManager.getAccount(source)
    if (!account) {
      warnings.push(`Configured source not available: ${source}`)
      return {
        source,
        account: null,
        positions: [],
        orders: [],
      }
    }

    const [accountInfo, positions, orders, marketClock] = await Promise.all([
      account.getAccount(),
      account.getPositions(),
      account.getOrders(),
      account.getMarketClock().catch(() => undefined),
    ])

    const grossExposure = accountInfo.equity > 0
      ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0) / accountInfo.equity * 100
      : 0

    totalExposurePercent += grossExposure
    totalPositions += positions.length

    return {
      source,
      account: accountInfo,
      positions,
      orders,
      marketClock,
    }
  }))

  if (totalPositions >= strategy.riskBudget.maxPositions) {
    warnings.push(`Current positions ${totalPositions} already meet/exceed maxPositions ${strategy.riskBudget.maxPositions}.`)
  }
  if (totalExposurePercent >= strategy.riskBudget.maxGrossExposurePercent) {
    warnings.push(`Current gross exposure ${totalExposurePercent.toFixed(2)}% meets/exceeds maxGrossExposurePercent ${strategy.riskBudget.maxGrossExposurePercent}%.`)
  }
  if (strategy.universe.asset === 'equity') {
    const anyOpen = sourceSnapshots.some((snapshot) => {
      const clock = snapshot.marketClock as { isOpen?: boolean } | undefined
      return clock?.isOpen === true
    })
    if (!anyOpen) {
      warnings.push('No configured equity source currently reports an open market clock.')
    }
  }

  return {
    frontalLobe,
    warnings,
    exposurePercent: clampPercent(totalExposurePercent),
    totalPositions,
    sourceSnapshots,
  }
}

export async function runTraderJob(
  params: { jobId: string; strategyId: string; session: SessionStore },
  deps: TraderRunnerDeps,
): Promise<TraderRunnerResult> {
  const strategy = await getTraderStrategy(params.strategyId)
  if (!strategy) {
    return { status: 'skip', reason: `Unknown strategy: ${params.strategyId}` }
  }
  if (!strategy.enabled) {
    return { status: 'skip', reason: `Strategy ${strategy.id} is disabled` }
  }

  const snapshot = await buildPreflightSnapshot(strategy, deps)
  if (snapshot.warnings.some((warning) => warning.includes('not available'))) {
    return { status: 'skip', reason: snapshot.warnings.join(' ') }
  }

  await setSessionSkill(params.session, 'trader-auto')
  const prompt = buildTraderPrompt(strategy, snapshot)
  const result = await deps.engine.askWithSession(prompt, params.session, {
    appendSystemPrompt: buildTraderSystemPrompt(strategy),
    historyPreamble: 'The following is the prior automated trader job history for this strategy.',
    maxHistoryEntries: 30,
  })

  const decision = parseTraderDecision(result.text, strategy.id)
  if (decision?.brainUpdate) {
    deps.brain.updateFrontalLobe(decision.brainUpdate)
  }

  return {
    status: decision?.status === 'skip' ? 'skip' : 'done',
    reason: decision?.rationale ?? 'Trader job completed',
    decision: decision ?? undefined,
    rawText: result.text,
  }
}

export async function runTraderReview(
  strategyId: string | undefined,
  deps: Pick<TraderRunnerDeps, 'brain' | 'accountManager' | 'getAccountGit' | 'eventLog'>,
  meta?: { trigger?: 'manual' | 'scheduled'; jobId?: string; jobName?: string },
): Promise<TraderReviewResult> {
  const sources = strategyId
    ? ((await getTraderStrategy(strategyId))?.sources ?? [])
    : deps.accountManager.listAccounts().map((account) => account.id)

  const summaries = sources.map((source) => {
    const git = deps.getAccountGit(source)
    if (!git) {
      return { source, summary: 'No trading history available.' }
    }
    const commits = git.log({ limit: 50 })
    const stats = computeTradingStats(commits)
    const topSymbol = Object.entries(stats.bySymbol)
      .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))[0]
    const summary = [
      `${stats.totalTrades} trades`,
      `winRate ${(stats.winRate * 100).toFixed(1)}%`,
      `totalPnL ${stats.totalPnL.toFixed(2)}`,
      topSymbol ? `top symbol ${topSymbol[0]} (${topSymbol[1].pnl.toFixed(2)})` : 'no closed trades yet',
    ].join(', ')
    return { source, summary }
  })

  const brainSummary = buildTraderReviewSummary({ strategyId, summaries })
  deps.brain.updateFrontalLobe(brainSummary)
  await deps.eventLog.append('trader.review.done', {
    strategyId,
    trigger: meta?.trigger ?? 'manual',
    jobId: meta?.jobId,
    jobName: meta?.jobName,
    updated: true,
    summary: brainSummary,
  })
  return {
    updated: true,
    summary: brainSummary,
    strategyId,
  }
}
