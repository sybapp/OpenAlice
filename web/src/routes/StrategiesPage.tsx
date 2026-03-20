import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  api,
  type CronSchedule,
  type EventLogEntry,
  type TraderJob,
  type TraderReviewJob,
  type TraderReviewResult,
  type TraderStrategyDetail,
  type TraderStrategyDraft,
  type TraderStrategySummary,
  type TraderStrategyUpdateResult,
  type TraderStrategyTemplate,
} from '../api'
import { Toggle } from '../components/Toggle'

type TraderMode = 'trade' | 'review'
type TraderAnyJob = TraderJob | TraderReviewJob
type TraderJobPatch = {
  name: string
  strategyId?: string
  schedule: CronSchedule
}

const ORDER_TYPE_OPTIONS = ['market', 'limit', 'stop', 'stop_limit', 'take_profit'] as const

type StrategyChangeActivity = {
  strategyId: string
  source: 'manual' | 'review'
  summary: string
  yamlDiff?: string
  ts: number
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour12: false })
  return `${date} ${time}`
}

function timeAgo(ts: number | null): string {
  if (!ts) return '-'
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function scheduleLabel(s: CronSchedule): string {
  switch (s.kind) {
    case 'at': return `at ${s.at}`
    case 'every': return `every ${s.every}`
    case 'cron': return `cron: ${s.cron}`
  }
}

function defaultScheduleValue(mode: TraderMode, kind: 'every' | 'cron' | 'at'): string {
  if (kind === 'every') return mode === 'trade' ? '1h' : '24h'
  if (kind === 'cron') return mode === 'trade' ? '0 */2 * * *' : '0 18 * * 5'
  return new Date(Date.now() + 3_600_000).toISOString()
}

function buildSchedule(kind: 'every' | 'cron' | 'at', value: string): CronSchedule {
  if (kind === 'every') return { kind: 'every', every: value }
  if (kind === 'cron') return { kind: 'cron', cron: value }
  return { kind: 'at', at: value }
}

function usePolling(load: () => Promise<void>, errorLabel: string) {
  useEffect(() => {
    load().catch((err) => console.warn(`${errorLabel}:`, err))
  }, [load, errorLabel])

  useEffect(() => {
    const id = setInterval(() => {
      load().catch((err) => console.warn(`${errorLabel}:`, err))
    }, 15_000)
    return () => clearInterval(id)
  }, [load, errorLabel])
}

function useTraderData() {
  const [strategies, setStrategies] = useState<TraderStrategySummary[]>([])
  const [jobs, setJobs] = useState<TraderJob[]>([])
  const [reviewJobs, setReviewJobs] = useState<TraderReviewJob[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [strategyRes, jobRes, reviewJobRes] = await Promise.all([
        api.strategies.listStrategies(),
        api.strategies.listJobs(),
        api.strategies.listReviewJobs(),
      ])
      setStrategies(strategyRes.strategies)
      setJobs(jobRes.jobs)
      setReviewJobs(reviewJobRes.jobs)
    } finally {
      setLoading(false)
    }
  }, [])

  usePolling(load, 'Failed to refresh strategy data')

  return { strategies, jobs, reviewJobs, loading, reload: load }
}

function useTraderEvents() {
  const [entries, setEntries] = useState<EventLogEntry[]>([])

  const load = useCallback(async () => {
    try {
      const result = await api.events.recent({ limit: 80 })
      setEntries(result.entries.filter((entry) =>
        entry.type === 'trader.done'
        || entry.type === 'trader.skip'
        || entry.type === 'trader.error'
        || entry.type.startsWith('trader.review.')).slice(-12).reverse())
    } catch (err) {
      console.warn('Failed to load trader events:', err)
    }
  }, [])

  usePolling(load, 'Failed to refresh trader events')

  return { entries, reload: load }
}

function useStrategyChangeActivity() {
  const [timelineByStrategyId, setTimelineByStrategyId] = useState<Record<string, StrategyChangeActivity[]>>({})

  const load = useCallback(async () => {
    try {
      const result = await api.events.recent({ limit: 120 })
      const next: Record<string, StrategyChangeActivity[]> = {}

      for (const entry of result.entries) {
        const payload = entry.payload as Record<string, unknown>
        const strategyId = typeof payload.strategyId === 'string' ? payload.strategyId : undefined
        if (!strategyId) {
          continue
        }

        let activity: StrategyChangeActivity | null = null
        if (entry.type === 'strategy.updated') {
          activity = {
            strategyId,
            source: 'manual',
            summary: typeof payload.summary === 'string' ? payload.summary : 'Manual strategy update.',
            yamlDiff: typeof payload.yamlDiff === 'string' ? payload.yamlDiff : undefined,
            ts: entry.ts,
          }
        } else if (entry.type === 'trader.review.done' && typeof payload.patchSummary === 'string') {
          activity = {
            strategyId,
            source: 'review',
            summary: payload.patchSummary,
            yamlDiff: typeof payload.yamlDiff === 'string' ? payload.yamlDiff : undefined,
            ts: entry.ts,
          }
        }

        if (!activity) {
          continue
        }

        const current = next[strategyId] ?? []
        next[strategyId] = [...current, activity]
      }

      for (const strategyId of Object.keys(next)) {
        next[strategyId] = next[strategyId]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 5)
      }

      setTimelineByStrategyId(next)
    } catch (err) {
      console.warn('Failed to load strategy change activity:', err)
    }
  }, [])

  usePolling(load, 'Failed to refresh strategy change activity')

  return { timelineByStrategyId, reload: load }
}

function useTraderTemplates() {
  const [templates, setTemplates] = useState<TraderStrategyTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.strategies.listTemplates()
      setTemplates(result.templates)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load strategy templates')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load().catch((err) => console.warn('Failed to load strategy templates:', err))
  }, [load])

  return { templates, loading, error, reload: load }
}

function cloneDraft(draft: TraderStrategyDraft): TraderStrategyDraft {
  return {
    ...draft,
    sources: [...draft.sources],
    universe: {
      ...draft.universe,
      symbols: [...draft.universe.symbols],
    },
    timeframes: { ...draft.timeframes },
    riskBudget: { ...draft.riskBudget },
    behaviorRules: {
      preferences: [...draft.behaviorRules.preferences],
      prohibitions: [...draft.behaviorRules.prohibitions],
    },
    executionPolicy: {
      ...draft.executionPolicy,
      allowedOrderTypes: [...draft.executionPolicy.allowedOrderTypes],
    },
  }
}

function detailToDraft(detail: TraderStrategyDetail): TraderStrategyDraft {
  return cloneDraft({
    id: detail.id,
    label: detail.label,
    enabled: detail.enabled,
    sources: detail.sources,
    universe: {
      asset: detail.asset,
      symbols: detail.symbols,
    },
    timeframes: detail.timeframes,
    riskBudget: detail.riskBudget,
    behaviorRules: detail.behaviorRules,
    executionPolicy: detail.executionPolicy,
  })
}

function draftToDetail(draft: TraderStrategyDraft): TraderStrategyDetail {
  return {
    id: draft.id,
    label: draft.label,
    enabled: draft.enabled,
    sources: [...draft.sources],
    asset: draft.universe.asset,
    symbols: [...draft.universe.symbols],
    timeframes: { ...draft.timeframes },
    riskBudget: { ...draft.riskBudget },
    behaviorRules: {
      preferences: [...draft.behaviorRules.preferences],
      prohibitions: [...draft.behaviorRules.prohibitions],
    },
    executionPolicy: {
      ...draft.executionPolicy,
      allowedOrderTypes: [...draft.executionPolicy.allowedOrderTypes],
    },
  }
}

function toMultiline(items: string[]): string {
  return items.join('\n')
}

function parseMultiline(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function StrategyDraftFields({
  draft,
  onChange,
  idEditable,
}: {
  draft: TraderStrategyDraft
  onChange: (next: TraderStrategyDraft) => void
  idEditable: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Strategy ID</span>
          <input
            aria-label="Strategy ID"
            type="text"
            value={draft.id}
            readOnly={!idEditable}
            onChange={(e) => onChange({ ...draft, id: e.target.value })}
            className={`w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none ${idEditable ? 'focus:border-accent' : 'cursor-not-allowed opacity-70'}`}
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Label</span>
          <input
            aria-label="Strategy label"
            type="text"
            value={draft.label}
            onChange={(e) => onChange({ ...draft, label: e.target.value })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Sources</span>
          <input
            aria-label="Strategy sources"
            type="text"
            value={draft.sources.join(', ')}
            onChange={(e) => onChange({
              ...draft,
              sources: e.target.value.split(',').map((item) => item.trim()).filter(Boolean),
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Symbols</span>
          <input
            aria-label="Strategy symbols"
            type="text"
            value={draft.universe.symbols.join(', ')}
            onChange={(e) => onChange({
              ...draft,
              universe: {
                ...draft.universe,
                symbols: e.target.value.split(',').map((item) => item.trim()).filter(Boolean),
              },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Context TF</span>
          <input
            aria-label="Context timeframe"
            type="text"
            value={draft.timeframes.context}
            onChange={(e) => onChange({ ...draft, timeframes: { ...draft.timeframes, context: e.target.value } })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Structure TF</span>
          <input
            aria-label="Structure timeframe"
            type="text"
            value={draft.timeframes.structure}
            onChange={(e) => onChange({ ...draft, timeframes: { ...draft.timeframes, structure: e.target.value } })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Execution TF</span>
          <input
            aria-label="Execution timeframe"
            type="text"
            value={draft.timeframes.execution}
            onChange={(e) => onChange({ ...draft, timeframes: { ...draft.timeframes, execution: e.target.value } })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Risk %</span>
          <input
            aria-label="Per-trade risk percent"
            type="number"
            min="0"
            step="0.01"
            value={draft.riskBudget.perTradeRiskPercent}
            onChange={(e) => onChange({
              ...draft,
              riskBudget: { ...draft.riskBudget, perTradeRiskPercent: Number(e.target.value) || 0 },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Gross %</span>
          <input
            aria-label="Max gross exposure percent"
            type="number"
            min="0"
            step="0.01"
            value={draft.riskBudget.maxGrossExposurePercent}
            onChange={(e) => onChange({
              ...draft,
              riskBudget: { ...draft.riskBudget, maxGrossExposurePercent: Number(e.target.value) || 0 },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Max Positions</span>
          <input
            aria-label="Max positions"
            type="number"
            min="1"
            step="1"
            value={draft.riskBudget.maxPositions}
            onChange={(e) => onChange({
              ...draft,
              riskBudget: { ...draft.riskBudget, maxPositions: Number(e.target.value) || 1 },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Daily Loss %</span>
          <input
            aria-label="Max daily loss percent"
            type="number"
            min="0"
            step="0.01"
            value={draft.riskBudget.maxDailyLossPercent ?? ''}
            onChange={(e) => onChange({
              ...draft,
              riskBudget: {
                ...draft.riskBudget,
                maxDailyLossPercent: e.target.value === '' ? undefined : Number(e.target.value),
              },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-text-muted">Execution Policy</div>
        <div className="flex flex-wrap gap-2">
          {ORDER_TYPE_OPTIONS.map((orderType) => {
            const checked = draft.executionPolicy.allowedOrderTypes.includes(orderType)
            return (
              <label key={orderType} className="flex items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
                <input
                  aria-label={`Order type ${orderType}`}
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...draft.executionPolicy.allowedOrderTypes, orderType]
                      : draft.executionPolicy.allowedOrderTypes.filter((value) => value !== orderType)
                    onChange({
                      ...draft,
                      executionPolicy: {
                        ...draft.executionPolicy,
                        allowedOrderTypes: [...new Set(next)],
                      },
                    })
                  }}
                />
                <span>{orderType}</span>
              </label>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-text-muted">
          <label className="flex items-center gap-2">
            <input
              aria-label="Require protection"
              type="checkbox"
              checked={draft.executionPolicy.requireProtection}
              onChange={(e) => onChange({
                ...draft,
                executionPolicy: { ...draft.executionPolicy, requireProtection: e.target.checked },
              })}
            />
            Require protection
          </label>
          <label className="flex items-center gap-2">
            <input
              aria-label="Allow market orders"
              type="checkbox"
              checked={draft.executionPolicy.allowMarketOrders}
              onChange={(e) => onChange({
                ...draft,
                executionPolicy: { ...draft.executionPolicy, allowMarketOrders: e.target.checked },
              })}
            />
            Allow market orders
          </label>
          <label className="flex items-center gap-2">
            <input
              aria-label="Allow overnight"
              type="checkbox"
              checked={draft.executionPolicy.allowOvernight}
              onChange={(e) => onChange({
                ...draft,
                executionPolicy: { ...draft.executionPolicy, allowOvernight: e.target.checked },
              })}
            />
            Allow overnight
          </label>
          <label className="flex items-center gap-2">
            <input
              aria-label="Strategy enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Preferences</span>
          <textarea
            aria-label="Strategy preferences"
            rows={8}
            value={toMultiline(draft.behaviorRules.preferences)}
            onChange={(e) => onChange({
              ...draft,
              behaviorRules: { ...draft.behaviorRules, preferences: parseMultiline(e.target.value) },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          <span className="font-medium uppercase tracking-wide">Prohibitions</span>
          <textarea
            aria-label="Strategy prohibitions"
            rows={8}
            value={toMultiline(draft.behaviorRules.prohibitions)}
            onChange={(e) => onChange({
              ...draft,
              behaviorRules: { ...draft.behaviorRules, prohibitions: parseMultiline(e.target.value) },
            })}
            className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
      </div>
    </div>
  )
}

export function StrategiesPage() {
  const { strategies, jobs, reviewJobs, loading, reload } = useTraderData()
  const { templates, loading: templatesLoading, error: templatesError, reload: reloadTemplates } = useTraderTemplates()
  const { entries: traderEvents, reload: reloadEvents } = useTraderEvents()
  const { timelineByStrategyId, reload: reloadStrategyActivity } = useStrategyChangeActivity()
  const [showAddJob, setShowAddJob] = useState(false)
  const [showAddReviewJob, setShowAddReviewJob] = useState(false)
  const [strategyDetails, setStrategyDetails] = useState<Record<string, TraderStrategyDetail | null>>({})
  const [reviewState, setReviewState] = useState<{
    running: boolean
    result: TraderReviewResult | null
    error: string | null
  }>({ running: false, result: null, error: null })

  const strategyMap = useMemo(
    () => new Map(strategies.map((strategy) => [strategy.id, strategy])),
    [strategies],
  )

  const reloadRuntime = useCallback(async () => {
    await reload()
    await reloadEvents()
    await reloadStrategyActivity()
  }, [reload, reloadEvents, reloadStrategyActivity])

  const runManualReview = useCallback(async (strategyId?: string) => {
    setReviewState({ running: true, result: null, error: null })
    try {
      const result = await api.strategies.runReview(strategyId)
      setReviewState({ running: false, result, error: null })
      await reloadRuntime()
    } catch (err) {
      setReviewState({
        running: false,
        result: null,
        error: err instanceof Error ? err.message : 'Review failed',
      })
    }
  }, [reloadRuntime])

  const loadStrategyDetail = useCallback(async (strategyId: string) => {
    if (strategyDetails[strategyId] !== undefined) {
      return
    }
    try {
      const detail = await api.strategies.getStrategy(strategyId)
      setStrategyDetails((prev) => ({ ...prev, [strategyId]: detail }))
    } catch (err) {
      console.warn(`Failed to load strategy detail for ${strategyId}:`, err)
      setStrategyDetails((prev) => ({ ...prev, [strategyId]: null }))
    }
  }, [strategyDetails])

  const handleStrategyUpdated = useCallback(async (result: TraderStrategyUpdateResult) => {
    setStrategyDetails((prev) => ({
      ...prev,
      [result.strategy.id]: draftToDetail(result.strategy),
    }))
    await reloadRuntime()
  }, [reloadRuntime])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-text-muted">
        Loading strategy runtime...
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between gap-4 px-4 md:px-6 py-4 border-b border-border shrink-0">
        <div>
          <h2 className="text-base font-semibold text-text">Strategies</h2>
          <p className="text-sm text-text-muted mt-1">Automated execution jobs and scheduled reviews for strategy-driven trading.</p>
        </div>
        <button
          onClick={() => runManualReview()}
          disabled={reviewState.running}
          className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
        >
          {reviewState.running ? 'Reviewing...' : 'Run Global Review'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5 space-y-6">
        <StrategyComposerSection
          templates={templates}
          loading={templatesLoading}
          error={templatesError}
          onCreated={async () => {
            await reloadTemplates()
            await reloadRuntime()
          }}
        />

        <StrategySection
          strategies={strategies}
          strategyDetails={strategyDetails}
          activityTimeline={timelineByStrategyId}
          onExpand={loadStrategyDetail}
          onUpdated={handleStrategyUpdated}
          onReview={runManualReview}
          reviewRunning={reviewState.running}
        />

        {reviewState.error && (
          <div className="rounded-lg border border-red/30 bg-red/5 px-4 py-3 text-sm text-red">
            {reviewState.error}
          </div>
        )}
        {reviewState.result && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
              <span>Latest Review Summary</span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${reviewState.result.updated ? 'border-green/30 text-green' : 'border-amber/30 text-amber'}`}>
                {reviewState.result.updated ? 'Brain updated' : 'Update skipped'}
              </span>
              {reviewState.result.patchApplied === true && (
                <span className="text-[11px] px-2 py-0.5 rounded-full border border-accent/30 text-accent">
                  YAML patched
                </span>
              )}
              {reviewState.result.patchApplied === false && reviewState.result.strategyId && (
                <span className="text-[11px] px-2 py-0.5 rounded-full border border-border text-text-muted">
                  No YAML patch
                </span>
              )}
            </div>
            {reviewState.result.strategyId && (
              <div className="mt-2 text-xs text-text-muted">
                Strategy: {reviewState.result.strategyId}
              </div>
            )}
            {reviewState.result.patchSummary && (
              <div className="mt-2 rounded-md border border-border/70 bg-bg px-3 py-2 text-xs text-text-muted">
                <div className="text-[11px] uppercase tracking-wide text-text-muted/80">Auto Update</div>
                <div className="mt-1 whitespace-pre-wrap break-words">{reviewState.result.patchSummary}</div>
              </div>
            )}
            {reviewState.result.yamlDiff && (
              <div className="mt-2 rounded-md border border-border/70 bg-bg px-3 py-2 text-xs text-text-muted">
                <div className="text-[11px] uppercase tracking-wide text-text-muted/80">YAML Diff</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{reviewState.result.yamlDiff}</pre>
              </div>
            )}
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-text-muted font-mono">{reviewState.result.summary}</pre>
          </div>
        )}

        <JobSection
          title="Strategy Jobs"
          description="Scheduled execution runs that analyze, decide, and trade using strategy guardrails."
          mode="trade"
          jobs={jobs}
          strategies={strategies}
          strategyMap={strategyMap}
          onAdd={() => setShowAddJob((value) => !value)}
          addOpen={showAddJob}
          addForm={(
            <TraderJobForm
              strategies={strategies}
              mode="trade"
              onClose={() => setShowAddJob(false)}
              onSaved={async () => {
                setShowAddJob(false)
                await reloadRuntime()
              }}
            />
          )}
          afterMutation={reloadRuntime}
          onToggle={async (job) => {
            await api.strategies.updateJob(job.id, { enabled: !job.enabled })
            await reloadRuntime()
          }}
          onRunNow={async (job) => {
            await api.strategies.runJob(job.id)
            await reloadRuntime()
          }}
          onDelete={async (job) => {
            await api.strategies.removeJob(job.id)
            await reloadRuntime()
          }}
        />

        <JobSection
          title="Review Jobs"
          description="Scheduled post-trade reviews that summarize recent performance and write guidance back into Brain."
          mode="review"
          jobs={reviewJobs}
          strategies={strategies}
          strategyMap={strategyMap}
          onAdd={() => setShowAddReviewJob((value) => !value)}
          addOpen={showAddReviewJob}
          addForm={(
            <TraderJobForm
              strategies={strategies}
              mode="review"
              allowGlobal
              onClose={() => setShowAddReviewJob(false)}
              onSaved={async () => {
                setShowAddReviewJob(false)
                await reloadRuntime()
              }}
            />
          )}
          afterMutation={reloadRuntime}
          onToggle={async (job) => {
            await api.strategies.updateReviewJob(job.id, { enabled: !job.enabled })
            await reloadRuntime()
          }}
          onRunNow={async (job) => {
            await api.strategies.runReviewJob(job.id)
            await reloadRuntime()
          }}
          onDelete={async (job) => {
            await api.strategies.removeReviewJob(job.id)
            await reloadRuntime()
          }}
        />

        <TraderEventsSection entries={traderEvents} />
      </div>
    </div>
  )
}

function StrategyComposerSection({
  templates,
  loading,
  error,
  onCreated,
}: {
  templates: TraderStrategyTemplate[]
  loading: boolean
  error: string | null
  onCreated: () => Promise<void>
}) {
  const [mode, setMode] = useState<'manual' | 'ai'>('manual')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [draft, setDraft] = useState<TraderStrategyDraft | null>(null)
  const [aiRequest, setAiRequest] = useState('')
  const [yamlPreview, setYamlPreview] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (!templates.length || selectedTemplateId) {
      return
    }
    const template = templates[0]
    setSelectedTemplateId(template.id)
    setDraft(cloneDraft(template.defaults))
  }, [templates, selectedTemplateId])

  const applyTemplate = useCallback((templateId: string) => {
    const template = templates.find((entry) => entry.id === templateId)
    if (!template) {
      return
    }
    setSelectedTemplateId(templateId)
    setDraft(cloneDraft(template.defaults))
    setYamlPreview('')
    setStatus(null)
    setSubmitError(null)
  }, [templates])

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null

  const saveDraft = useCallback(async () => {
    if (!draft) {
      setSubmitError('Choose a template first')
      return
    }
    setSaving(true)
    setSubmitError(null)
    setStatus(null)
    try {
      const created = await api.strategies.createStrategy(draft)
      setDraft(cloneDraft(created))
      setStatus(`Saved strategy ${created.label} (${created.id}) to runtime/strategies.`)
      setYamlPreview('')
      await onCreated()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }, [draft, onCreated])

  const generateDraft = useCallback(async () => {
    if (!selectedTemplateId) {
      setSubmitError('Choose a template first')
      return
    }
    setGenerating(true)
    setSubmitError(null)
    setStatus(null)
    try {
      const result = await api.strategies.generateStrategy({
        templateId: selectedTemplateId as TraderStrategyTemplate['id'],
        request: aiRequest.trim(),
      })
      setDraft(cloneDraft(result.draft))
      setYamlPreview(result.yamlPreview)
      setMode('ai')
      setStatus('AI draft ready. Review the YAML preview, then save when it looks right.')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Generate failed')
    } finally {
      setGenerating(false)
    }
  }, [aiRequest, selectedTemplateId])

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text">Strategy Composer</h3>
        <p className="text-xs text-text-muted mt-1">Start from a template, refine it manually, or let the backend AI draft a YAML preview before you save it.</p>
      </div>

      <div className="rounded-lg border border-border bg-bg px-4 py-4 space-y-4">
        {loading ? (
          <div className="text-sm text-text-muted">Loading strategy templates...</div>
        ) : error ? (
          <div className="text-sm text-red">{error}</div>
        ) : templates.length === 0 ? (
          <div className="text-sm text-text-muted">No strategy templates are available yet.</div>
        ) : (
          <>
            <div className="grid gap-3 lg:grid-cols-[220px,1fr]">
              <div className="space-y-1">
                <label htmlFor="strategy-template" className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Template
                </label>
                <select
                  id="strategy-template"
                  aria-label="Strategy template"
                  value={selectedTemplateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-md border border-border/70 bg-bg-secondary px-3 py-3">
                <div className="text-sm font-medium text-text">{selectedTemplate?.label ?? 'Template preview'}</div>
                <div className="mt-1 text-xs text-text-muted">{selectedTemplate?.description}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setMode('manual')}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${mode === 'manual' ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-muted hover:text-text hover:bg-bg-tertiary'}`}
              >
                Manual Fill
              </button>
              <button
                type="button"
                onClick={() => setMode('ai')}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${mode === 'ai' ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-muted hover:text-text hover:bg-bg-tertiary'}`}
              >
                AI Generate
              </button>
              <button
                type="button"
                onClick={() => selectedTemplateId && applyTemplate(selectedTemplateId)}
                className="px-3 py-1.5 text-xs rounded-md border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
              >
                Reset To Template
              </button>
            </div>

            {mode === 'ai' && (
              <div className="space-y-3 rounded-md border border-accent/20 bg-accent/5 px-4 py-4">
                <div>
                  <label htmlFor="ai-request" className="text-sm font-medium text-text">AI Brief</label>
                  <p className="mt-1 text-xs text-text-muted">Describe trigger levels, symbols, risk preferences, or guardrails. The model must stay inside the strategy schema.</p>
                </div>
                <textarea
                  id="ai-request"
                  aria-label="AI generation request"
                  value={aiRequest}
                  onChange={(e) => setAiRequest(e.target.value)}
                  rows={5}
                  placeholder="Example: Build a BTC breakout plan on binance-main with explicit long and short trigger levels, 5m false-break rules, and no overnight exposure."
                  className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => { void generateDraft() }}
                    disabled={generating}
                    className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
                  >
                    {generating ? 'Generating...' : 'Generate Draft'}
                  </button>
                </div>
              </div>
            )}

            {draft && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr),minmax(320px,1fr)]">
                <StrategyDraftFields
                  draft={draft}
                  onChange={(next) => setDraft(next)}
                  idEditable
                />

                <div className="space-y-3">
                  <div className="rounded-md border border-border/70 bg-bg-secondary px-3 py-3">
                    <div className="text-sm font-medium text-text">Preview</div>
                    <div className="mt-2 text-xs text-text-muted space-y-1">
                      <div>ID: {draft.id || '-'}</div>
                      <div>Sources: {draft.sources.join(', ') || '-'}</div>
                      <div>Symbols: {draft.universe.symbols.join(', ') || '-'}</div>
                      <div>Order Types: {draft.executionPolicy.allowedOrderTypes.join(', ') || '-'}</div>
                    </div>
                  </div>

                  {yamlPreview && (
                    <div className="rounded-md border border-border/70 bg-bg-secondary px-3 py-3">
                      <div className="text-sm font-medium text-text">YAML Preview</div>
                      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-[11px] text-text-muted font-mono">{yamlPreview}</pre>
                    </div>
                  )}

                  {submitError && (
                    <div className="rounded-md border border-red/30 bg-red/5 px-3 py-2 text-xs text-red">
                      {submitError}
                    </div>
                  )}
                  {status && (
                    <div className="rounded-md border border-green/30 bg-green/5 px-3 py-2 text-xs text-green">
                      {status}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => { void saveDraft() }}
                    disabled={saving || !draft}
                    className="w-full px-3 py-2 text-sm rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : yamlPreview ? 'Save Generated Strategy' : 'Save Strategy'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function StrategySection({
  strategies,
  strategyDetails,
  activityTimeline,
  onExpand,
  onUpdated,
  onReview,
  reviewRunning,
}: {
  strategies: TraderStrategySummary[]
  strategyDetails: Record<string, TraderStrategyDetail | null>
  activityTimeline: Record<string, StrategyChangeActivity[]>
  onExpand: (strategyId: string) => Promise<void>
  onUpdated: (result: TraderStrategyUpdateResult) => Promise<void>
  onReview: (strategyId?: string) => Promise<void>
  reviewRunning: boolean
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text">Strategies</h3>
        <p className="text-xs text-text-muted mt-1">These are loaded from `runtime/strategies/*.yml`. Create new YAML-backed strategies above, then inspect and review them here.</p>
      </div>

      {strategies.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg px-4 py-6 text-sm text-text-muted text-center">
          No strategy YAML files found yet.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {strategies.map((strategy) => (
            <StrategyCard
              key={strategy.id}
              strategy={strategy}
              detail={strategyDetails[strategy.id]}
              activityTimeline={activityTimeline[strategy.id] ?? []}
              onExpand={onExpand}
              onUpdated={onUpdated}
              onReview={onReview}
              reviewRunning={reviewRunning}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function StrategyCard({
  strategy,
  detail,
  activityTimeline,
  onExpand,
  onUpdated,
  onReview,
  reviewRunning,
}: {
  strategy: TraderStrategySummary
  detail?: TraderStrategyDetail | null
  activityTimeline: StrategyChangeActivity[]
  onExpand: (strategyId: string) => Promise<void>
  onUpdated: (result: TraderStrategyUpdateResult) => Promise<void>
  onReview: (strategyId?: string) => Promise<void>
  reviewRunning: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<TraderStrategyDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const latestActivity = activityTimeline[0]

  const toggle = async () => {
    const next = !expanded
    setExpanded(next)
    if (next) {
      await onExpand(strategy.id)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-bg px-4 py-4">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-text">{strategy.label}</div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${strategy.enabled ? 'border-green/30 text-green' : 'border-border text-text-muted'}`}>
          {strategy.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <div className="mt-2 text-xs text-text-muted space-y-1">
        <div>ID: {strategy.id}</div>
        <div>Asset: {strategy.asset}</div>
        <div>Sources: {strategy.sources.join(', ')}</div>
        <div>Universe: {strategy.symbols.join(', ')}</div>
        {latestActivity && (
          <div>
            Latest change: {latestActivity.source === 'manual' ? 'Manual edit' : 'Review patch'}
            {' '}• {timeAgo(latestActivity.ts)} • {latestActivity.summary}
          </div>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onReview(strategy.id)}
          disabled={reviewRunning}
          className="px-3 py-1.5 text-xs rounded-md border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-50"
        >
          Run Review
        </button>
        <button
          onClick={() => { void toggle() }}
          className="px-3 py-1.5 text-xs rounded-md border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
        >
          {expanded ? 'Hide Details' : 'Show Details'}
        </button>
        <button
          onClick={async () => {
            if (!expanded) {
              await toggle()
              return
            }
            if (detail) {
              setDraft(detailToDraft(detail))
              setEditing(true)
              setError(null)
              setStatus(null)
            }
          }}
          className="px-3 py-1.5 text-xs rounded-md border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
        >
          Edit Strategy
        </button>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border/50 pt-3 text-xs text-text-muted space-y-2">
          {editing && draft ? (
            <div className="space-y-3">
              <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-3">
                <div className="text-sm font-medium text-text">Edit Strategy</div>
                <div className="mt-1 text-xs text-text-muted">Strategy ID stays fixed so existing jobs and reviews keep their references.</div>
              </div>
              <StrategyDraftFields
                draft={draft}
                onChange={setDraft}
                idEditable={false}
              />
              {error && (
                <div className="rounded-md border border-red/30 bg-red/5 px-3 py-2 text-xs text-red">
                  {error}
                </div>
              )}
              {status && (
                <div className="rounded-md border border-green/30 bg-green/5 px-3 py-2 text-xs text-green">
                  {status}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false)
                    setDraft(detail ? detailToDraft(detail) : null)
                    setError(null)
                    setStatus(null)
                  }}
                  className="px-3 py-1.5 text-sm rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    if (!draft) return
                    setSaving(true)
                    setError(null)
                    setStatus(null)
                    try {
                      const result = await api.strategies.updateStrategy(strategy.id, draft)
                      await onUpdated(result)
                      setDraft(cloneDraft(result.strategy))
                      setStatus(result.changeReport.summary)
                      setEditing(false)
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Save failed')
                    } finally {
                      setSaving(false)
                    }
                  }}
                  className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          ) : detail ? (
            <>
              <div>Timeframes: {detail.timeframes.context} / {detail.timeframes.structure} / {detail.timeframes.execution}</div>
              <div>
                Risk Budget:
                {' '}risk {detail.riskBudget.perTradeRiskPercent}%,
                gross {detail.riskBudget.maxGrossExposurePercent}%,
                max positions {detail.riskBudget.maxPositions}
                {detail.riskBudget.maxDailyLossPercent != null ? `, daily loss ${detail.riskBudget.maxDailyLossPercent}%` : ''}
              </div>
              <div>Execution: {detail.executionPolicy.allowedOrderTypes.join(', ')}</div>
              <div>Protection required: {detail.executionPolicy.requireProtection ? 'yes' : 'no'}</div>
              <div>Market orders: {detail.executionPolicy.allowMarketOrders ? 'allowed' : 'not allowed'}</div>
              <div>Overnight: {detail.executionPolicy.allowOvernight ? 'allowed' : 'not allowed'}</div>
              {detail.behaviorRules.preferences.length > 0 && (
                <div>Preferences: {detail.behaviorRules.preferences.join('; ')}</div>
              )}
              {detail.behaviorRules.prohibitions.length > 0 && (
                <div>Prohibitions: {detail.behaviorRules.prohibitions.join('; ')}</div>
              )}
              {activityTimeline.length > 0 && (
                <div className="rounded-md border border-border/70 bg-bg-secondary px-3 py-2 space-y-3">
                  <div className="text-[11px] uppercase tracking-wide text-text-muted/80">Recent Change Timeline</div>
                  {activityTimeline.map((activity, index) => (
                    <div key={`${activity.ts}-${index}`} className="border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
                      <div className="text-text">
                        {activity.source === 'manual' ? 'Manual edit' : 'Review patch'}
                        {' '}• {timeAgo(activity.ts)}
                      </div>
                      <div className="mt-1">{activity.summary}</div>
                      {activity.yamlDiff && (
                        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">{activity.yamlDiff}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div>{detail === null ? 'Failed to load strategy details.' : 'Loading strategy details...'}</div>
          )}
        </div>
      )}
    </div>
  )
}

function JobSection({
  title,
  description,
  mode,
  jobs,
  strategies,
  strategyMap,
  onAdd,
  addOpen,
  addForm,
  afterMutation,
  onToggle,
  onRunNow,
  onDelete,
}: {
  title: string
  description: string
  mode: TraderMode
  jobs: TraderAnyJob[]
  strategies: TraderStrategySummary[]
  strategyMap: Map<string, TraderStrategySummary>
  onAdd: () => void
  addOpen: boolean
  addForm: ReactNode
  afterMutation: () => Promise<void>
  onToggle: (job: TraderAnyJob) => Promise<void>
  onRunNow: (job: TraderAnyJob) => Promise<void>
  onDelete: (job: TraderAnyJob) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)

  const wrap = useCallback(async (fn: () => Promise<void>, fallback: string) => {
    try {
      await fn()
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
      setTimeout(() => setError(null), 3000)
    }
  }, [])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          <p className="text-xs text-text-muted mt-1">{description}</p>
        </div>
        <button
          onClick={onAdd}
          className="text-xs px-3 py-1.5 rounded-md bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors"
        >
          + Add Job
        </button>
      </div>

      {error && <div className="text-xs text-red">{error}</div>}
      {addOpen && addForm}

      {jobs.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg px-4 py-6 text-sm text-text-muted text-center">
          No jobs configured yet.
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <TraderJobCard
              key={job.id}
              mode={mode}
              job={job}
              strategies={strategies}
              strategy={job.strategyId ? strategyMap.get(job.strategyId) : undefined}
              onToggle={() => wrap(() => onToggle(job), 'Failed to toggle job')}
              onRunNow={() => wrap(() => onRunNow(job), 'Failed to run job')}
              onUpdate={(patch) => wrap(async () => {
                await updateJob(mode, job.id, patch)
                await afterMutation()
              }, 'Failed to update job')}
              onDelete={() => wrap(() => onDelete(job), 'Failed to delete job')}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function TraderEventsSection({ entries }: { entries: EventLogEntry[] }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text">Recent Strategy Events</h3>
        <p className="text-xs text-text-muted mt-1">Latest execution and review events from the event log.</p>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg px-4 py-6 text-sm text-text-muted text-center">
          No trader events yet.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-bg-secondary text-text-muted">
              <tr>
                <th className="px-4 py-2 text-left">Time</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-left">Payload</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.seq} className="border-t border-border/50 align-top">
                  <td className="px-4 py-2 text-text-muted whitespace-nowrap">{formatDateTime(entry.ts)}</td>
                  <td className="px-4 py-2 text-text">{entry.type}</td>
                  <td className="px-4 py-2 text-text-muted">
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                      {JSON.stringify(entry.payload, null, 2)}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function TraderJobCard({
  mode,
  job,
  strategies,
  strategy,
  onToggle,
  onRunNow,
  onUpdate,
  onDelete,
}: {
  mode: TraderMode
  job: TraderAnyJob
  strategies: TraderStrategySummary[]
  strategy?: TraderStrategySummary
  onToggle: () => void
  onRunNow: () => void
  onUpdate: (patch: TraderJobPatch) => Promise<void>
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  return (
    <div className={`rounded-lg border ${job.enabled ? 'border-border' : 'border-border/50 opacity-60'} bg-bg`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <Toggle size="sm" checked={job.enabled} onChange={onToggle} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{job.name}</span>
            <span className="text-xs text-text-muted">{job.id}</span>
            {job.state.lastStatus === 'error' && (
              <span className="text-xs text-red">{job.state.consecutiveErrors}x err</span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {scheduleLabel(job.schedule)}
            {job.state.nextRunAtMs && <span className="ml-2">• next: {formatDateTime(job.state.nextRunAtMs)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button aria-label={`Run ${job.name} now`} onClick={onRunNow} title="Run now" className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-tertiary transition-colors text-xs">▶</button>
          <button
            aria-label={`Edit ${job.name}`}
            onClick={() => {
              setExpanded(true)
              setEditing((value) => !value || !expanded)
            }}
            title="Edit"
            className="p-1.5 rounded text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors text-xs"
          >
            ✎
          </button>
          <button aria-label={`Toggle details for ${job.name}`} onClick={() => setExpanded((value) => !value)} title="Details" className="p-1.5 rounded text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors text-xs">
            {expanded ? '▾' : '▸'}
          </button>
          <button aria-label={`Delete ${job.name}`} onClick={onDelete} title="Delete" className="p-1.5 rounded text-text-muted hover:text-red hover:bg-bg-tertiary transition-colors text-xs">✕</button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 text-xs space-y-2 text-text-muted">
          <div>Strategy: {strategy ? `${strategy.label} (${strategy.id})` : job.strategyId ?? 'Global review'}</div>
          <div>Last run: {job.state.lastRunAtMs ? `${timeAgo(job.state.lastRunAtMs)} (${formatDateTime(job.state.lastRunAtMs)})` : 'never'}</div>
          <div>Status: {job.state.lastStatus ?? 'n/a'}</div>
          <div>Created: {formatDateTime(job.createdAt)}</div>
          {editing && (
            <div className="pt-2">
              <TraderJobForm
                strategies={strategies}
                mode={mode}
                allowGlobal={mode === 'review'}
                initialJob={job}
                onClose={() => setEditing(false)}
                onSaved={async (patch) => {
                  await onUpdate(patch)
                  setEditing(false)
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function scheduleFormState(schedule: CronSchedule): { kind: 'every' | 'cron' | 'at'; value: string } {
  if (schedule.kind === 'every') return { kind: 'every', value: schedule.every }
  if (schedule.kind === 'cron') return { kind: 'cron', value: schedule.cron }
  return { kind: 'at', value: schedule.at }
}

async function updateJob(mode: TraderMode, id: string, patch: TraderJobPatch) {
  if (mode === 'trade') {
    await api.strategies.updateJob(id, patch)
    return
  }
  await api.strategies.updateReviewJob(id, patch)
}

function TraderJobForm({
  strategies,
  mode,
  allowGlobal = false,
  initialJob,
  onClose,
  onSaved,
}: {
  strategies: TraderStrategySummary[]
  mode: TraderMode
  allowGlobal?: boolean
  initialJob?: TraderAnyJob
  onClose: () => void
  onSaved: (patch: TraderJobPatch) => Promise<void>
}) {
  const initialSchedule = initialJob
    ? scheduleFormState(initialJob.schedule)
    : { kind: 'every' as const, value: defaultScheduleValue(mode, 'every') }

  const [name, setName] = useState(initialJob?.name ?? '')
  const [strategyId, setStrategyId] = useState<string>(initialJob?.strategyId ?? (allowGlobal ? '' : (strategies[0]?.id ?? '')))
  const [schedKind, setSchedKind] = useState<'every' | 'cron' | 'at'>(initialSchedule.kind)
  const [schedValue, setSchedValue] = useState(initialSchedule.value)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (!allowGlobal && !strategyId) {
      setError('Strategy is required')
      return
    }

    setSaving(true)
    setError('')
    try {
      const patch: TraderJobPatch = {
        name: name.trim(),
        strategyId: strategyId || undefined,
        schedule: buildSchedule(schedKind, schedValue),
      }

      if (initialJob) {
        await onSaved(patch)
      } else {
        if (mode === 'trade') {
          await api.strategies.addJob({
            name: patch.name,
            strategyId: strategyId,
            schedule: patch.schedule,
          })
        } else {
          await api.strategies.addReviewJob({
            name: patch.name,
            strategyId: patch.strategyId,
            schedule: patch.schedule,
          })
        }
        await onSaved(patch)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : initialJob ? 'Save failed' : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-bg rounded-lg border border-accent/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text">
          {initialJob
            ? mode === 'trade' ? 'Edit Strategy Job' : 'Edit Review Job'
            : mode === 'trade' ? 'New Strategy Job' : 'New Review Job'}
        </span>
        <button type="button" onClick={onClose} className="text-text-muted hover:text-text text-xs">✕</button>
      </div>

      <input
        type="text"
        placeholder="Job name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
      />

      <select
        value={strategyId}
        onChange={(e) => setStrategyId(e.target.value)}
        className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
      >
        {allowGlobal && <option value="">All strategies</option>}
        {strategies.map((strategy) => (
          <option key={strategy.id} value={strategy.id}>
            {strategy.label} ({strategy.id})
          </option>
        ))}
      </select>

      <div className="flex gap-2">
        <select
          value={schedKind}
          onChange={(e) => {
            const kind = e.target.value as 'every' | 'cron' | 'at'
            setSchedKind(kind)
            setSchedValue(defaultScheduleValue(mode, kind))
          }}
          className="bg-bg-tertiary border border-border rounded-md px-2 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="every">Every</option>
          <option value="cron">Cron</option>
          <option value="at">At</option>
        </select>

        <input
          type="text"
          value={schedValue}
          onChange={(e) => setSchedValue(e.target.value)}
          placeholder={schedKind === 'every' ? '1h' : schedKind === 'cron' ? '0 18 * * 5' : 'ISO timestamp'}
          className="flex-1 bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent font-mono"
        />
      </div>

      {error && <div className="text-xs text-red">{error}</div>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50">
          {saving ? initialJob ? 'Saving...' : 'Creating...' : initialJob ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}
