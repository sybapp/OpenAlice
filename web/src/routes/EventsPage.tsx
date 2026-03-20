import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { api, type EventLogEntry, type CronJob, type CronSchedule } from '../api'
import { useSSE } from '../hooks/useSSE'
import { Toggle } from '../components/Toggle'

// ==================== Helpers ====================

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

type TraderEventTone = {
  badge: string
  card: string
  label: string
  accent: string
}

type TraderQuickFilter = 'all' | 'trader' | 'executed' | 'skipped' | 'error' | 'review'
type Tab = 'events' | 'cron'

const traderQuickFilters: Array<{ value: TraderQuickFilter, label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'trader', label: 'Trader' },
  { value: 'executed', label: 'Executed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'error', label: 'Error' },
  { value: 'review', label: 'Review' },
]

function isTraderQuickFilter(value: string | null): value is TraderQuickFilter {
  return value === 'all'
    || value === 'trader'
    || value === 'executed'
    || value === 'skipped'
    || value === 'error'
    || value === 'review'
}

function isTab(value: string | null): value is Tab {
  return value === 'events' || value === 'cron'
}

function readSearchParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams()
  return new URLSearchParams(window.location.search)
}

function replaceSearchParams(updater: (params: URLSearchParams) => void): void {
  if (typeof window === 'undefined') return

  const params = new URLSearchParams(window.location.search)
  updater(params)

  const next = params.toString()
  const nextUrl = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`
  window.history.replaceState(window.history.state, '', nextUrl)
}

function traderEventTone(type: string): TraderEventTone {
  if (type === 'trader.done') {
    return {
      label: 'Executed',
      accent: 'text-green',
      badge: 'border-green/40 bg-green/12 text-green',
      card: 'border-green/25 bg-green/8',
    }
  }

  if (type === 'trader.skip' || type === 'trader.review.skip') {
    return {
      label: 'Skipped',
      accent: 'text-notification-border',
      badge: 'border-notification-border/40 bg-notification-bg/70 text-notification-border',
      card: 'border-notification-border/25 bg-notification-bg/35',
    }
  }

  if (type === 'trader.error' || type === 'trader.review.error') {
    return {
      label: 'Error',
      accent: 'text-red',
      badge: 'border-red/40 bg-red/12 text-red',
      card: 'border-red/25 bg-red/8',
    }
  }

  if (type.startsWith('trader.review.')) {
    return {
      label: 'Review',
      accent: 'text-accent',
      badge: 'border-accent/40 bg-accent/12 text-accent',
      card: 'border-accent/25 bg-accent/6',
    }
  }

  return {
    label: 'Trader',
    accent: 'text-accent',
    badge: 'border-accent/40 bg-accent/12 text-accent',
    card: 'border-border bg-bg-secondary',
  }
}

function matchesTraderQuickFilter(entry: EventLogEntry, quickFilter: TraderQuickFilter): boolean {
  if (quickFilter === 'all') return true
  if (!entry.type.startsWith('trader.')) return false

  switch (quickFilter) {
    case 'trader':
      return true
    case 'executed':
      return entry.type === 'trader.done'
    case 'skipped':
      return entry.type === 'trader.skip' || entry.type === 'trader.review.skip'
    case 'error':
      return entry.type === 'trader.error' || entry.type === 'trader.review.error'
    case 'review':
      return entry.type.startsWith('trader.review.')
    case 'all':
      return true
  }
}

// Map event types to color classes
function eventTypeColor(type: string): string {
  if (type.startsWith('heartbeat.')) return 'text-purple'
  if (type.startsWith('cron.')) return 'text-accent'
  if (type.startsWith('message.')) return 'text-green'
  if (type.startsWith('trader.')) return traderEventTone(type).accent
  return 'text-text-muted'
}

function formatTraderPayloadPreview(type: string, payload: unknown): string | null {
  if (!type.startsWith('trader.')) return null
  if (!isRecord(payload)) return null

  const strategyId = asString(payload.strategyId)
  const reason = asString(payload.reason)
  const error = asString(payload.error)
  const summary = asString(payload.summary)
  const source = isRecord(payload.decision) ? asString(payload.decision.source) : null
  const symbol = isRecord(payload.decision) ? asString(payload.decision.symbol) : null

  const parts = [
    strategyId,
    source && symbol ? `${source} • ${symbol}` : source ?? symbol,
    reason ?? error ?? summary,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' — ') : null
}

function renderTraderPayloadDetails(type: string, payload: unknown): ReactNode | null {
  if (!type.startsWith('trader.') || !isRecord(payload)) return null

  const tone = traderEventTone(type)
  const decision = isRecord(payload.decision) ? payload.decision : null
  const actionsTaken = decision ? asStringArray(decision.actionsTaken) : []
  const invalidation = decision ? asStringArray(decision.invalidation) : []
  const strategyId = asString(payload.strategyId)
  const jobLabel = asString(payload.jobName) ?? asString(payload.jobId)
  const reason = asString(payload.reason)
  const error = asString(payload.error)
  const summary = asString(payload.summary)
  const source = decision ? asString(decision.source) : null
  const symbol = decision ? asString(decision.symbol) : null
  const scenario = decision ? asString(decision.chosenScenario) : null
  const channel = asString(payload.channel)
  const headline = error ?? reason ?? summary
  const chips = [
    source ? `Source: ${source}` : null,
    symbol ? `Symbol: ${symbol}` : null,
    scenario ? `Scenario: ${scenario}` : null,
    channel ? `Channel: ${channel}` : null,
  ].filter((value): value is string => Boolean(value))

  const rows: Array<[string, string | null]> = [
    ['Strategy', strategyId],
    ['Job', jobLabel],
    ['Reason', reason],
    ['Error', error],
    ['Summary', summary],
  ]

  const visibleRows = rows.filter(([, value]) => value)
  if (visibleRows.length === 0 && chips.length === 0 && actionsTaken.length === 0 && invalidation.length === 0) return null

  return (
    <div className={`mb-3 rounded-lg border p-3 text-[11px] shadow-sm ${tone.card}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${tone.badge}`}>
          {tone.label}
        </span>
        {strategyId && <span className="font-semibold text-text">{strategyId}</span>}
        {jobLabel && <span className="text-text-muted">{jobLabel}</span>}
      </div>

      {headline && (
        <div className="mt-3 rounded-md border border-border/40 bg-bg/45 px-3 py-2 text-sm text-text whitespace-pre-wrap break-words">
          {headline}
        </div>
      )}

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-border/60 bg-bg/55 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted"
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      {visibleRows.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {visibleRows.map(([label, value]) => (
            <div key={label} className="rounded-md border border-border/40 bg-bg/45 px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
              <div className="text-text whitespace-pre-wrap break-words">{value}</div>
            </div>
          ))}
        </div>
      )}

      {actionsTaken.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">Actions</div>
          <div className="space-y-1">
            {actionsTaken.map((action) => (
              <div key={action} className="rounded-md border border-border/40 bg-bg/45 px-3 py-2 text-text whitespace-pre-wrap break-words">
                {action}
              </div>
            ))}
          </div>
        </div>
      )}
      {invalidation.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">Invalidation</div>
          <div className="space-y-1">
            {invalidation.map((item) => (
              <div key={item} className="rounded-md border border-border/40 bg-bg/45 px-3 py-2 text-text whitespace-pre-wrap break-words">
                {item}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== EventLog Section ====================

const PAGE_SIZE = 100

function EventLogSection() {
  const initialQuery = useRef(readSearchParams())
  const initialTypeFilter = initialQuery.current.get('type') ?? ''
  const [entries, setEntries] = useState<EventLogEntry[]>([])
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter)
  const [traderQuickFilter, setTraderQuickFilter] = useState<TraderQuickFilter>(() => {
    const value = initialQuery.current.get('trader')
    return isTraderQuickFilter(value) ? value : 'all'
  })
  const [paused, setPaused] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [types, setTypes] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const visibleEntries = entries.filter((entry) => matchesTraderQuickFilter(entry, traderQuickFilter))
  const hasTraderQuickFilter = traderQuickFilter !== 'all'

  // Fetch a page from disk
  const fetchPage = useCallback(async (p: number, type?: string) => {
    setLoading(true)
    try {
      const result = await api.events.query({
        page: p,
        pageSize: PAGE_SIZE,
        type: type || undefined,
      })
      setEntries(result.entries)
      setPage(result.page)
      setTotalPages(result.totalPages)
      setTotal(result.total)
    } catch (err) {
      console.warn('Failed to load events:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchPage(1, initialTypeFilter || undefined)
  }, [fetchPage, initialTypeFilter])

  useEffect(() => {
    replaceSearchParams((params) => {
      if (typeFilter) params.set('type', typeFilter)
      else params.delete('type')

      if (traderQuickFilter !== 'all') params.set('trader', traderQuickFilter)
      else params.delete('trader')
    })
  }, [typeFilter, traderQuickFilter])

  // Track all seen event types (persists across page changes)
  useEffect(() => {
    if (entries.length > 0) {
      setTypes((prev) => {
        const next = new Set(prev)
        for (const e of entries) next.add(e.type)
        return [...next].sort()
      })
    }
  }, [entries])

  // SSE for real-time events — only affects page 1
  useSSE({
    url: '/api/events/stream',
    onMessage: (entry: EventLogEntry) => {
      // Always track new types
      setTypes((prev) => {
        if (prev.includes(entry.type)) return prev
        return [...prev, entry.type].sort()
      })
      // Increment total
      setTotal((prev) => prev + 1)
      // Only prepend to visible list when on page 1 and matching filter
      if (page === 1) {
        const matchesFilter = (!typeFilter || entry.type === typeFilter) && matchesTraderQuickFilter(entry, traderQuickFilter)
        if (matchesFilter) {
          setEntries((prev) => [entry, ...prev].slice(0, PAGE_SIZE))
        }
      }
    },
    enabled: !paused,
  })

  // Type filter change → reset to page 1
  const handleTypeChange = useCallback((type: string) => {
    setTypeFilter(type)
    fetchPage(1, type || undefined)
  }, [fetchPage])

  // Page navigation
  const goToPage = useCallback((p: number) => {
    fetchPage(p, typeFilter || undefined)
    containerRef.current?.scrollTo(0, 0)
  }, [fetchPage, typeFilter])

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Controls */}
      <div className="flex flex-col gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={typeFilter}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="bg-bg-tertiary text-text text-sm rounded-md border border-border px-2 py-1.5 outline-none focus:border-accent"
          >
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <button
            onClick={() => setPaused(!paused)}
            className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
              paused
                ? 'border-notification-border text-notification-border hover:bg-notification-bg'
                : 'border-border text-text-muted hover:bg-bg-tertiary'
            }`}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>

          <span className="text-xs text-text-muted ml-auto">
            {total > 0
              ? `Page ${page} of ${totalPages} · ${total} events`
              : '0 events'
            }
            {hasTraderQuickFilter && ` · ${visibleEntries.length} shown`}
            {(typeFilter || hasTraderQuickFilter) && ' (filtered)'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-text-muted">Quick filters</span>
          {traderQuickFilters.map((filter) => {
            const active = traderQuickFilter === filter.value
            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => setTraderQuickFilter(filter.value)}
                className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                  active
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-border text-text-muted hover:bg-bg-tertiary hover:text-text'
                }`}
              >
                {filter.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Event list — fills remaining space */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-bg rounded-lg border border-border overflow-y-auto font-mono text-xs"
      >
        {loading && visibleEntries.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-muted">Loading...</div>
        ) : visibleEntries.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-muted">
            {entries.length === 0 ? 'No events yet' : 'No events match the current filters'}
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-bg-secondary">
              <tr className="text-text-muted text-left">
                <th className="px-3 py-2 w-12">#</th>
                <th className="px-3 py-2 w-36">Time</th>
                <th className="px-3 py-2 w-40">Type</th>
                <th className="px-3 py-2">Payload</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => (
                <EventRow key={entry.seq} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 shrink-0">
          <button
            onClick={() => goToPage(1)}
            disabled={page <= 1 || loading}
            className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ««
          </button>
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1 || loading}
            className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            «
          </button>
          <span className="text-xs text-text-muted px-2">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages || loading}
            className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            »
          </button>
          <button
            onClick={() => goToPage(totalPages)}
            disabled={page >= totalPages || loading}
            className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            »»
          </button>
        </div>
      )}
    </div>
  )
}

function EventRow({ entry }: { entry: EventLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const payloadStr = JSON.stringify(entry.payload)
  const traderPreview = formatTraderPayloadPreview(entry.type, entry.payload)
  const isLong = payloadStr.length > 120
  const preview = traderPreview ?? (isLong ? payloadStr.slice(0, 120) + '...' : payloadStr)
  const hasFormattedDetails = Boolean(renderTraderPayloadDetails(entry.type, entry.payload))
  const isExpandable = isLong || hasFormattedDetails

  return (
    <>
      <tr
        className="border-t border-border/50 hover:bg-bg-secondary/50 cursor-pointer"
        onClick={() => isExpandable && setExpanded(!expanded)}
      >
        <td className="px-3 py-1.5 text-text-muted">{entry.seq}</td>
        <td className="px-3 py-1.5 text-text-muted whitespace-nowrap">{formatDateTime(entry.ts)}</td>
        <td className={`px-3 py-1.5 ${eventTypeColor(entry.type)}`}>{entry.type}</td>
        <td className="px-3 py-1.5 text-text-muted truncate">
          {preview}
          {isExpandable && (
            <span className="ml-1 text-accent">{expanded ? '▾' : '▸'}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-border/30">
          <td colSpan={4} className="px-3 py-2">
            {renderTraderPayloadDetails(entry.type, entry.payload)}
            {hasFormattedDetails && (
              <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-text-muted">Raw Payload</div>
            )}
            <pre className="text-text-muted whitespace-pre-wrap break-all bg-bg-tertiary rounded p-2 text-[11px]">
              {JSON.stringify(entry.payload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}

// ==================== Cron Section ====================

function CronSection() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  const loadJobs = useCallback(async () => {
    try {
      const { jobs } = await api.cron.list()
      setJobs(jobs)
    } catch (err) {
      console.warn('Failed to load cron jobs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadJobs() }, [loadJobs])

  // Refresh periodically to update next-run times
  useEffect(() => {
    const id = setInterval(loadJobs, 15_000)
    return () => clearInterval(id)
  }, [loadJobs])

  const [error, setError] = useState<string | null>(null)

  const showError = (msg: string) => {
    setError(msg)
    setTimeout(() => setError(null), 3000)
  }

  const handleToggle = async (job: CronJob) => {
    try {
      await api.cron.update(job.id, { enabled: !job.enabled })
      await loadJobs()
    } catch {
      showError('Failed to toggle job')
    }
  }

  const handleRunNow = async (job: CronJob) => {
    try {
      await api.cron.runNow(job.id)
      await loadJobs()
    } catch {
      showError('Failed to run job')
    }
  }

  const handleDelete = async (job: CronJob) => {
    if (job.name === '__heartbeat__') return
    try {
      await api.cron.remove(job.id)
      await loadJobs()
    } catch {
      showError('Failed to delete job')
    }
  }

  if (loading) {
    return <div className="text-text-muted text-sm py-4">Loading cron jobs...</div>
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="text-xs text-red">{error}</div>}
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">{jobs.length} jobs</span>
        <button
          onClick={() => setShowAdd(true)}
          className="text-xs px-3 py-1.5 rounded-md bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors"
        >
          + Add Job
        </button>
      </div>

      {showAdd && (
        <AddCronJobForm
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); loadJobs() }}
        />
      )}

      {jobs.length === 0 ? (
        <div className="text-text-muted text-sm text-center py-6">No cron jobs</div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={() => handleToggle(job)}
              onRunNow={() => handleRunNow(job)}
              onDelete={() => handleDelete(job)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CronJobCard({ job, onToggle, onRunNow, onDelete }: {
  job: CronJob
  onToggle: () => void
  onRunNow: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isHeartbeat = job.name === '__heartbeat__'

  return (
    <div className={`rounded-lg border ${job.enabled ? 'border-border' : 'border-border/50 opacity-60'} bg-bg`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <Toggle size="sm" checked={job.enabled} onChange={() => onToggle()} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${isHeartbeat ? 'text-purple' : 'text-text'}`}>
              {isHeartbeat ? '💓 heartbeat' : job.name}
            </span>
            <span className="text-xs text-text-muted">{job.id}</span>
            {job.state.lastStatus === 'error' && (
              <span className="text-xs text-red">
                {job.state.consecutiveErrors}x err
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {scheduleLabel(job.schedule)}
            {job.state.nextRunAtMs && (
              <span className="ml-2">• next: {formatDateTime(job.state.nextRunAtMs)}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onRunNow}
            title="Run now"
            className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-tertiary transition-colors text-xs"
          >
            ▶
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            title="Details"
            className="p-1.5 rounded text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors text-xs"
          >
            {expanded ? '▾' : '▸'}
          </button>
          {!isHeartbeat && (
            <button
              onClick={onDelete}
              title="Delete"
              className="p-1.5 rounded text-text-muted hover:text-red hover:bg-bg-tertiary transition-colors text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 text-xs space-y-2">
          <div>
            <span className="text-text-muted">Payload: </span>
            <pre className="inline text-text whitespace-pre-wrap break-all">{job.payload}</pre>
          </div>
          <div className="flex gap-4 text-text-muted">
            <span>Last run: {job.state.lastRunAtMs ? `${timeAgo(job.state.lastRunAtMs)} (${formatDateTime(job.state.lastRunAtMs)})` : 'never'}</span>
            <span>Status: {job.state.lastStatus ?? 'n/a'}</span>
            <span>Created: {formatDateTime(job.createdAt)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function AddCronJobForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [payload, setPayload] = useState('')
  const [schedKind, setSchedKind] = useState<'every' | 'cron' | 'at'>('every')
  const [schedValue, setSchedValue] = useState('1h')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !payload.trim()) {
      setError('Name and payload are required')
      return
    }

    let schedule: CronSchedule
    if (schedKind === 'every') schedule = { kind: 'every', every: schedValue }
    else if (schedKind === 'cron') schedule = { kind: 'cron', cron: schedValue }
    else schedule = { kind: 'at', at: schedValue }

    setSaving(true)
    setError('')
    try {
      await api.cron.add({ name: name.trim(), payload: payload.trim(), schedule })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-bg rounded-lg border border-accent/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text">New Cron Job</span>
        <button type="button" onClick={onClose} className="text-text-muted hover:text-text text-xs">✕</button>
      </div>

      <input
        type="text"
        placeholder="Job name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
      />

      <textarea
        placeholder="Payload / instruction text"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={2}
        className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent resize-none"
      />

      <div className="flex gap-2">
        <select
          value={schedKind}
          onChange={(e) => {
            const k = e.target.value as 'every' | 'cron' | 'at'
            setSchedKind(k)
            if (k === 'every') setSchedValue('1h')
            else if (k === 'cron') setSchedValue('0 9 * * 1-5')
            else setSchedValue(new Date(Date.now() + 3600_000).toISOString())
          }}
          className="bg-bg-tertiary border border-border rounded-md px-2 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="every">Every</option>
          <option value="cron">Cron</option>
          <option value="at">At (one-shot)</option>
        </select>

        <input
          type="text"
          value={schedValue}
          onChange={(e) => setSchedValue(e.target.value)}
          placeholder={schedKind === 'every' ? '1h' : schedKind === 'cron' ? '0 9 * * 1-5' : 'ISO timestamp'}
          className="flex-1 bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent font-mono"
        />
      </div>

      {error && <div className="text-xs text-red">{error}</div>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
        >
          {saving ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  )
}

export function EventsPage() {
  const initialQuery = useRef(readSearchParams())
  const [tab, setTab] = useState<Tab>(() => {
    const value = initialQuery.current.get('tab')
    return isTab(value) ? value : 'events'
  })

  useEffect(() => {
    replaceSearchParams((params) => {
      if (tab !== 'events') params.set('tab', tab)
      else params.delete('tab')
    })
  }, [tab])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Page header */}
      <div className="flex items-center gap-4 px-4 md:px-6 py-4 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-text">Events</h2>
        <div className="flex gap-1 bg-bg-secondary rounded-lg p-1">
          <button
            onClick={() => setTab('events')}
            className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
              tab === 'events'
                ? 'bg-bg-tertiary text-text'
                : 'text-text-muted hover:text-text'
            }`}
          >
            Event Log
          </button>
          <button
            onClick={() => setTab('cron')}
            className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
              tab === 'cron'
                ? 'bg-bg-tertiary text-text'
                : 'text-text-muted hover:text-text'
            }`}
          >
            Cron Jobs
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-h-0 px-4 md:px-6 py-5">
        <div className="flex-1 min-h-0">
          {tab === 'events' ? <EventLogSection /> : <CronSection />}
        </div>
      </div>
    </div>
  )
}
