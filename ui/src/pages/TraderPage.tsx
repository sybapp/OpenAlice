import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type CronSchedule, type EventLogEntry, type TraderJob, type TraderReviewJob, type TraderReviewResult, type TraderStrategyDetail, type TraderStrategySummary } from '../api'
import { Toggle } from '../components/Toggle'

type TraderMode = 'trade' | 'review'
type TraderAnyJob = TraderJob | TraderReviewJob
type TraderJobPatch = {
  name: string
  strategyId?: string
  schedule: CronSchedule
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
        api.trader.listStrategies(),
        api.trader.listJobs(),
        api.trader.listReviewJobs(),
      ])
      setStrategies(strategyRes.strategies)
      setJobs(jobRes.jobs)
      setReviewJobs(reviewJobRes.jobs)
    } finally {
      setLoading(false)
    }
  }, [])

  usePolling(load, 'Failed to refresh trader data')

  return { strategies, jobs, reviewJobs, loading, reload: load }
}

function useTraderEvents() {
  const [entries, setEntries] = useState<EventLogEntry[]>([])

  const load = useCallback(async () => {
    try {
      const result = await api.events.recent({ limit: 80 })
      setEntries(result.entries.filter((entry) => entry.type.startsWith('trader.')).slice(-12).reverse())
    } catch (err) {
      console.warn('Failed to load trader events:', err)
    }
  }, [])

  usePolling(load, 'Failed to refresh trader events')

  return { entries, reload: load }
}

export function TraderPage() {
  const { strategies, jobs, reviewJobs, loading, reload } = useTraderData()
  const { entries: traderEvents, reload: reloadEvents } = useTraderEvents()
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
  }, [reload, reloadEvents])

  const runManualReview = useCallback(async (strategyId?: string) => {
    setReviewState({ running: true, result: null, error: null })
    try {
      const result = await api.trader.runReview(strategyId)
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
      const detail = await api.trader.getStrategy(strategyId)
      setStrategyDetails((prev) => ({ ...prev, [strategyId]: detail }))
    } catch (err) {
      console.warn(`Failed to load strategy detail for ${strategyId}:`, err)
      setStrategyDetails((prev) => ({ ...prev, [strategyId]: null }))
    }
  }, [strategyDetails])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-text-muted">
        Loading trader runtime...
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between gap-4 px-4 md:px-6 py-4 border-b border-border shrink-0">
        <div>
          <h2 className="text-base font-semibold text-text">Trader</h2>
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
        <StrategySection
          strategies={strategies}
          strategyDetails={strategyDetails}
          onExpand={loadStrategyDetail}
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
            <div className="text-sm font-medium text-text">Latest Review Summary</div>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-text-muted font-mono">{reviewState.result.summary}</pre>
          </div>
        )}

        <JobSection
          title="Trader Jobs"
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
            await api.trader.updateJob(job.id, { enabled: !job.enabled })
            await reloadRuntime()
          }}
          onRunNow={async (job) => {
            await api.trader.runJob(job.id)
            await reloadRuntime()
          }}
          onDelete={async (job) => {
            await api.trader.removeJob(job.id)
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
            await api.trader.updateReviewJob(job.id, { enabled: !job.enabled })
            await reloadRuntime()
          }}
          onRunNow={async (job) => {
            await api.trader.runReviewJob(job.id)
            await reloadRuntime()
          }}
          onDelete={async (job) => {
            await api.trader.removeReviewJob(job.id)
            await reloadRuntime()
          }}
        />

        <TraderEventsSection entries={traderEvents} />
      </div>
    </div>
  )
}

function StrategySection({
  strategies,
  strategyDetails,
  onExpand,
  onReview,
  reviewRunning,
}: {
  strategies: TraderStrategySummary[]
  strategyDetails: Record<string, TraderStrategyDetail | null>
  onExpand: (strategyId: string) => Promise<void>
  onReview: (strategyId?: string) => Promise<void>
  reviewRunning: boolean
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text">Strategies</h3>
        <p className="text-xs text-text-muted mt-1">These come from `data/strategies/*.yml` and are read-only in the UI for now.</p>
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
              onExpand={onExpand}
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
  onExpand,
  onReview,
  reviewRunning,
}: {
  strategy: TraderStrategySummary
  detail?: TraderStrategyDetail | null
  onExpand: (strategyId: string) => Promise<void>
  onReview: (strategyId?: string) => Promise<void>
  reviewRunning: boolean
}) {
  const [expanded, setExpanded] = useState(false)

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
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border/50 pt-3 text-xs text-text-muted space-y-2">
          {detail ? (
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
        <h3 className="text-sm font-semibold text-text">Recent Trader Events</h3>
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
    await api.trader.updateJob(id, patch)
    return
  }
  await api.trader.updateReviewJob(id, patch)
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
          await api.trader.addJob({
            name: patch.name,
            strategyId: strategyId,
            schedule: patch.schedule,
          })
        } else {
          await api.trader.addReviewJob({
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
            ? mode === 'trade' ? 'Edit Trader Job' : 'Edit Review Job'
            : mode === 'trade' ? 'New Trader Job' : 'New Review Job'}
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
