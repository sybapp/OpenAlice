import { type ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  api,
  type BacktestBar,
  type BacktestDecisionPlanEntry,
  type BacktestEquityPoint,
  type BacktestEventEntry,
  type BacktestGitState,
  type BacktestRunManifest,
  type BacktestRunRecord,
  type BacktestRunSummary,
  type BacktestStartRunRequest,
  type SessionEntry,
} from '../api'
import { Field, Section, inputClass } from '../components/form'

const RUN_POLL_MS = 5_000
const EQUITY_POINT_LIMIT = 500
const EVENT_LIMIT = 200
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

type DetailTab = 'events' | 'git' | 'session'

interface BacktestDetails {
  run: BacktestRunRecord | null
  summary: BacktestRunSummary | null
  equity: BacktestEquityPoint[]
  events: BacktestEventEntry[]
  gitState: BacktestGitState | null
  sessionEntries: SessionEntry[]
}

const EMPTY_DETAILS: BacktestDetails = {
  run: null,
  summary: null,
  equity: [],
  events: [],
  gitState: null,
  sessionEntries: [],
}

export function BacktestPage() {
  const [runs, setRuns] = useState<BacktestRunManifest[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [details, setDetails] = useState<BacktestDetails>(EMPTY_DETAILS)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [detailsError, setDetailsError] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [tab, setTab] = useState<DetailTab>('events')
  const [eventFilter, setEventFilter] = useState('')
  const deferredEventFilter = useDeferredValue(eventFilter)

  const refreshRuns = useCallback(async (preferredRunId?: string | null) => {
    setRunsError('')
    setLoadingRuns(true)
    try {
      const result = await api.backtest.listRuns()
      setRuns(result.runs)
      setSelectedRunId((current) => {
        if (preferredRunId && result.runs.some((run) => run.runId === preferredRunId)) {
          return preferredRunId
        }
        if (current && result.runs.some((run) => run.runId === current)) {
          return current
        }
        return result.runs[0]?.runId ?? null
      })
    } catch (err) {
      setRunsError(asMessage(err))
    } finally {
      setLoadingRuns(false)
    }
  }, [])

  const loadDetails = useCallback(async (runId: string, quiet = false) => {
    if (!quiet) {
      setLoadingDetails(true)
      setDetailsError('')
    }

    try {
      const [run, summary, equity, events, gitState, session] = await Promise.all([
        api.backtest.getRun(runId),
        withNotFoundFallback(() => api.backtest.getSummary(runId)),
        api.backtest.getEquityCurve(runId, EQUITY_POINT_LIMIT),
        api.backtest.getEvents(runId, { limit: EVENT_LIMIT }),
        withNotFoundFallback(() => api.backtest.getGitState(runId)),
        withNotFoundFallback(() => api.backtest.getSessionEntries(runId), { entries: [] as SessionEntry[] }),
      ])

      setDetails({
        run,
        summary,
        equity: equity.points,
        events: events.entries,
        gitState,
        sessionEntries: session?.entries ?? [],
      })
    } catch (err) {
      setDetailsError(asMessage(err))
      setDetails(EMPTY_DETAILS)
    } finally {
      if (!quiet) setLoadingDetails(false)
    }
  }, [])

  useEffect(() => {
    refreshRuns()
  }, [refreshRuns])

  useEffect(() => {
    if (!selectedRunId) {
      setDetails(EMPTY_DETAILS)
      return
    }
    loadDetails(selectedRunId)
  }, [loadDetails, selectedRunId])

  const selectedManifest = useMemo(
    () => details.run?.manifest ?? runs.find((run) => run.runId === selectedRunId) ?? null,
    [details.run, runs, selectedRunId],
  )

  useEffect(() => {
    if (!selectedRunId || !selectedManifest) return
    if (selectedManifest.status !== 'queued' && selectedManifest.status !== 'running') return

    const timer = setInterval(() => {
      refreshRuns(selectedRunId)
      void loadDetails(selectedRunId, true)
    }, RUN_POLL_MS)

    return () => clearInterval(timer)
  }, [loadDetails, refreshRuns, selectedManifest, selectedRunId])

  const filteredEvents = useMemo(() => {
    const needle = deferredEventFilter.trim().toLowerCase()
    if (!needle) return details.events
    return details.events.filter((entry) => entry.type.toLowerCase().includes(needle))
  }, [deferredEventFilter, details.events])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 border-b border-border">
        <div className="px-4 md:px-6 py-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text">Backtest</h2>
            <p className="text-[12px] text-text-muted mt-1">
              Run and inspect replay-based backtests for equities and crypto.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refreshRuns(selectedRunId)}
              className="px-3 py-1.5 text-[13px] font-medium rounded-md border border-border hover:bg-bg-tertiary transition-colors"
            >
              Refresh
            </button>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="px-3 py-1.5 text-[13px] font-medium rounded-md bg-accent text-bg hover:opacity-90 transition-opacity"
            >
              New Backtest
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="border-b xl:border-b-0 xl:border-r border-border min-h-0 overflow-y-auto">
            <RunList
              runs={runs}
              selectedRunId={selectedRunId}
              loading={loadingRuns}
              error={runsError}
              onSelect={setSelectedRunId}
              onCreate={() => setShowCreateDialog(true)}
            />
          </aside>

          <main className="min-h-0 overflow-y-auto px-4 md:px-6 py-5">
            <div className="max-w-[1100px] space-y-5">
              {detailsError && (
                <div className="rounded-lg border border-red/40 bg-red/10 px-4 py-3 text-[13px] text-red">
                  {detailsError}
                </div>
              )}

              {!selectedManifest && !loadingRuns && (
                <EmptyDetails onCreate={() => setShowCreateDialog(true)} />
              )}

              {selectedManifest && (
                <>
                  <RunHero manifest={selectedManifest} loading={loadingDetails} />
                  <SummaryGrid summary={details.summary} manifest={selectedManifest} />
                  <EquityCard points={details.equity} />
                  <DetailTabs tab={tab} onChange={setTab} />
                  {tab === 'events' && (
                    <EventsPanel
                      entries={filteredEvents}
                      filter={eventFilter}
                      onFilterChange={setEventFilter}
                    />
                  )}
                  {tab === 'git' && <GitPanel state={details.gitState} />}
                  {tab === 'session' && <SessionPanel entries={details.sessionEntries} />}
                </>
              )}
            </div>
          </main>
        </div>
      </div>

      {showCreateDialog && (
        <CreateBacktestDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={async (runId) => {
            setShowCreateDialog(false)
            await refreshRuns(runId)
            setSelectedRunId(runId)
            await loadDetails(runId)
          }}
        />
      )}
    </div>
  )
}

function RunList({
  runs,
  selectedRunId,
  loading,
  error,
  onSelect,
  onCreate,
}: {
  runs: BacktestRunManifest[]
  selectedRunId: string | null
  loading: boolean
  error: string
  onSelect: (runId: string) => void
  onCreate: () => void
}) {
  return (
    <div className="p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-text-muted uppercase tracking-wide">
          Runs
        </h3>
        <span className="text-[12px] text-text-muted">{runs.length}</span>
      </div>

      {loading && runs.length === 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary px-4 py-6 text-[13px] text-text-muted">
          Loading runs...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red/40 bg-red/10 px-4 py-3 text-[13px] text-red mb-3">
          {error}
        </div>
      )}

      {runs.length === 0 && !loading ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-text-muted">No backtests yet.</p>
          <button
            onClick={onCreate}
            className="mt-3 text-[13px] text-accent hover:underline"
          >
            Create your first run
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => {
            const active = run.runId === selectedRunId
            return (
              <button
                key={run.runId}
                onClick={() => onSelect(run.runId)}
                className={`w-full text-left rounded-lg border px-3 py-3 transition-colors ${
                  active
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-bg-secondary hover:bg-bg-tertiary'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-text">{run.runId}</span>
                  <StatusBadge status={run.status} />
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12px] text-text-muted">
                  <span>{run.mode.toUpperCase()}</span>
                  <span>•</span>
                  <span>{run.barCount} bars</span>
                  <span>•</span>
                  <span>step {run.currentStep}</span>
                </div>
                <div className="mt-1 text-[11px] text-text-muted/70">
                  {formatDateTime(run.createdAt)}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function EmptyDetails({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-6 py-10 text-center">
      <p className="text-sm text-text">No backtest selected.</p>
      <p className="text-[12px] text-text-muted mt-1">
        Start a new replay run or choose one from the list.
      </p>
      <button
        onClick={onCreate}
        className="mt-4 px-3 py-1.5 text-[13px] font-medium rounded-md bg-accent text-bg hover:opacity-90 transition-opacity"
      >
        New Backtest
      </button>
    </div>
  )
}

function RunHero({ manifest, loading }: { manifest: BacktestRunManifest; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[18px] font-semibold text-text">{manifest.runId}</h3>
            <StatusBadge status={manifest.status} />
            {loading && <span className="text-[12px] text-text-muted">Refreshing...</span>}
          </div>
          <p className="text-[12px] text-text-muted mt-1">
            {manifest.mode.toUpperCase()} replay on {manifest.accountLabel}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-right text-[12px] text-text-muted">
          <div>
            <p>Created</p>
            <p className="text-text mt-1">{formatDateTime(manifest.createdAt)}</p>
          </div>
          <div>
            <p>Bars</p>
            <p className="text-text mt-1">{manifest.barCount}</p>
          </div>
          <div>
            <p>Current Step</p>
            <p className="text-text mt-1">{manifest.currentStep}</p>
          </div>
          <div>
            <p>Initial Cash</p>
            <p className="text-text mt-1">{formatMoney(manifest.initialCash)}</p>
          </div>
        </div>
      </div>

      {manifest.error && (
        <div className="mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red">
          {manifest.error}
        </div>
      )}
    </div>
  )
}

function SummaryGrid({
  summary,
  manifest,
}: {
  summary: BacktestRunSummary | null
  manifest: BacktestRunManifest
}) {
  if (!summary) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-5 py-4 text-[13px] text-text-muted">
        {manifest.status === 'completed' || manifest.status === 'failed'
          ? 'Summary not available for this run.'
          : 'Summary will populate as the run progresses.'}
      </div>
    )
  }

  const cards = [
    { label: 'Start Equity', value: formatMoney(summary.startEquity) },
    { label: 'End Equity', value: formatMoney(summary.endEquity) },
    { label: 'Total Return', value: formatPercent(summary.totalReturn), tone: summary.totalReturn },
    { label: 'Realized PnL', value: formatSignedMoney(summary.realizedPnL), tone: summary.realizedPnL },
    { label: 'Unrealized PnL', value: formatSignedMoney(summary.unrealizedPnL), tone: summary.unrealizedPnL },
    { label: 'Max Drawdown', value: formatPercent(summary.maxDrawdown), tone: summary.maxDrawdown > 0 ? -summary.maxDrawdown : summary.maxDrawdown },
    { label: 'Trades', value: String(summary.tradeCount) },
    { label: 'Win Rate', value: formatPercent(summary.winRate) },
    { label: 'Guard Rejections', value: String(summary.guardRejectionCount) },
  ]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {cards.map((card) => {
        const toneClass = card.tone == null ? 'text-text' : card.tone > 0 ? 'text-green' : card.tone < 0 ? 'text-red' : 'text-text'
        return (
          <div key={card.label} className="rounded-xl border border-border bg-bg-secondary px-4 py-4">
            <p className="text-[11px] uppercase tracking-wide text-text-muted">{card.label}</p>
            <p className={`mt-2 text-[22px] font-semibold ${toneClass}`}>{card.value}</p>
          </div>
        )
      })}
    </div>
  )
}

function EquityCard({ points }: { points: BacktestEquityPoint[] }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[13px] font-semibold text-text-muted uppercase tracking-wide">
            Equity Curve
          </h3>
          <p className="text-[12px] text-text-muted mt-1">
            {points.length > 0 ? `${points.length} samples` : 'No equity samples yet'}
          </p>
        </div>
        {points.length > 0 && (
          <div className="text-right text-[12px] text-text-muted">
            <p>Range</p>
            <p className="text-text mt-1">
              {formatMoney(Math.min(...points.map((point) => point.equity)))} - {formatMoney(Math.max(...points.map((point) => point.equity)))}
            </p>
          </div>
        )}
      </div>
      <EquityChart points={points} />
    </div>
  )
}

function EquityChart({ points }: { points: BacktestEquityPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-[13px] text-text-muted">
        Equity data will appear here after the first replay step.
      </div>
    )
  }

  const width = 720
  const height = 220
  const padding = 16
  const values = points.map((point) => point.equity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const polyline = points
    .map((point, index) => {
      const x = padding + ((width - padding * 2) * index) / Math.max(points.length - 1, 1)
      const y = height - padding - ((point.equity - min) / span) * (height - padding * 2)
      return `${x},${y}`
    })
    .join(' ')
  const first = points[0]
  const last = points[points.length - 1]
  const delta = last.equity - first.equity

  return (
    <div>
      <div className="h-[220px] w-full overflow-hidden rounded-lg border border-border bg-bg">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
          <path
            d={`M ${padding} ${height - padding} L ${width - padding} ${height - padding}`}
            stroke="rgba(139, 148, 158, 0.35)"
            strokeWidth="1"
          />
          <polyline
            fill="none"
            stroke={delta >= 0 ? 'var(--color-green)' : 'var(--color-red)'}
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polyline}
          />
        </svg>
      </div>
      <div className="mt-3 flex items-center justify-between text-[12px] text-text-muted">
        <span>{formatDateTime(first.ts)}</span>
        <span className={delta >= 0 ? 'text-green' : 'text-red'}>
          {formatSignedMoney(delta)}
        </span>
        <span>{formatDateTime(last.ts)}</span>
      </div>
    </div>
  )
}

function DetailTabs({ tab, onChange }: { tab: DetailTab; onChange: (tab: DetailTab) => void }) {
  const tabs: DetailTab[] = ['events', 'git', 'session']

  return (
    <div className="flex items-center gap-2 border-b border-border">
      {tabs.map((value) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={`px-3 py-2 text-[13px] font-medium border-b-2 transition-colors ${
            tab === value
              ? 'border-accent text-text'
              : 'border-transparent text-text-muted hover:text-text'
          }`}
        >
          {value === 'git' ? 'Git' : value.charAt(0).toUpperCase() + value.slice(1)}
        </button>
      ))}
    </div>
  )
}

function EventsPanel({
  entries,
  filter,
  onFilterChange,
}: {
  entries: BacktestEventEntry[]
  filter: string
  onFilterChange: (value: string) => void
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[13px] font-semibold text-text-muted uppercase tracking-wide">
            Events
          </h3>
          <p className="text-[12px] text-text-muted mt-1">
            Showing the latest {entries.length} matching entries.
          </p>
        </div>
        <input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter by event type"
          className="w-full sm:w-[220px] px-3 py-2 bg-bg text-text border border-border rounded-md text-sm outline-none focus:border-accent"
        />
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-muted">
          No events match this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.seq} className="rounded-lg border border-border bg-bg px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-[12px] text-text">{entry.type}</div>
                <div className="text-[11px] text-text-muted">
                  #{entry.seq} • {formatTimestamp(entry.ts)}
                </div>
              </div>
              <JsonBlock value={entry.payload} className="mt-3" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GitPanel({ state }: { state: BacktestGitState | null }) {
  if (!state || state.commits.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-5 py-8 text-center text-[13px] text-text-muted">
        No git snapshot available for this run yet.
      </div>
    )
  }

  const commits = [...state.commits].reverse()

  return (
    <div className="space-y-3">
      {commits.map((commit) => (
        <div key={commit.hash} className="rounded-xl border border-border bg-bg-secondary px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-semibold text-text">{commit.message}</p>
              <p className="text-[12px] text-text-muted mt-1">
                {commit.hash} {commit.round != null ? `• round ${commit.round}` : ''} • {formatDateTime(commit.timestamp)}
              </p>
            </div>
            <div className="text-right text-[12px] text-text-muted">
              <p>{commit.operations.length} ops</p>
              <p className="mt-1 text-text">{formatMoney(commit.stateAfter.equity)} equity</p>
            </div>
          </div>

          {commit.operations.length > 0 && (
            <div className="mt-4">
              <p className="text-[11px] uppercase tracking-wide text-text-muted mb-2">Operations</p>
              <div className="space-y-2">
                {commit.operations.map((operation, index) => (
                  <div key={`${commit.hash}-${index}`} className="rounded-lg border border-border bg-bg px-3 py-3">
                    <div className="text-[13px] font-medium text-text">{operation.action}</div>
                    <JsonBlock value={operation.params} className="mt-2" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {commit.results.length > 0 && (
            <div className="mt-4">
              <p className="text-[11px] uppercase tracking-wide text-text-muted mb-2">Results</p>
              <JsonBlock value={commit.results} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function SessionPanel({ entries }: { entries: SessionEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-5 py-8 text-center text-[13px] text-text-muted">
        No session transcript stored for this run.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <div key={entry.uuid} className="rounded-xl border border-border bg-bg-secondary px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                entry.type === 'assistant'
                  ? 'bg-accent/10 text-accent'
                  : entry.type === 'user'
                    ? 'bg-green/10 text-green'
                    : 'bg-bg-tertiary text-text-muted'
              }`}>
                {entry.type}
              </span>
              <span className="text-[12px] text-text-muted">{entry.message.role}</span>
            </div>
            <div className="text-[11px] text-text-muted">{formatDateTime(entry.timestamp)}</div>
          </div>
          <div className="mt-3 space-y-2">
            {renderSessionContent(entry)}
          </div>
        </div>
      ))}
    </div>
  )
}

function renderSessionContent(entry: SessionEntry) {
  const content = entry.message.content
  if (typeof content === 'string') {
    return <pre className="whitespace-pre-wrap break-words text-[12px] text-text">{content}</pre>
  }

  return content.map((block, index) => {
    if (block.type === 'text') {
      return (
        <pre key={`${entry.uuid}-${index}`} className="whitespace-pre-wrap break-words text-[12px] text-text">
          {block.text}
        </pre>
      )
    }
    if (block.type === 'image') {
      return (
        <a
          key={`${entry.uuid}-${index}`}
          href={block.url}
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-accent hover:underline"
        >
          {block.url}
        </a>
      )
    }
    if (block.type === 'tool_use') {
      return (
        <div key={`${entry.uuid}-${index}`} className="rounded-lg border border-border bg-bg px-3 py-3">
          <p className="text-[12px] font-medium text-text">Tool: {block.name}</p>
          <JsonBlock value={block.input} className="mt-2" />
        </div>
      )
    }
    return (
      <div key={`${entry.uuid}-${index}`} className="rounded-lg border border-border bg-bg px-3 py-3">
        <p className="text-[12px] font-medium text-text">Tool result: {block.tool_use_id}</p>
        <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] text-text-muted">{block.content}</pre>
      </div>
    )
  })
}

function CreateBacktestDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (runId: string) => Promise<void>
}) {
  const [runId, setRunId] = useState('')
  const [initialCash, setInitialCash] = useState('10000')
  const [assetType, setAssetType] = useState<'equity' | 'crypto'>('equity')
  const [symbol, setSymbol] = useState('AAPL')
  const [startDate, setStartDate] = useState('2025-01-01')
  const [endDate, setEndDate] = useState('2025-01-31')
  const [interval, setInterval] = useState('1d')
  const [mode, setMode] = useState<'ai' | 'scripted'>('ai')
  const [prompt, setPrompt] = useState('Trade the replay conservatively and explain each action.')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [maxHistoryEntries, setMaxHistoryEntries] = useState('20')
  const [decisionsJson, setDecisionsJson] = useState('[]')
  const [bars, setBars] = useState<BacktestBar[]>([])
  const [barsLoading, setBarsLoading] = useState(false)
  const [barsError, setBarsError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setBars([])
    setBarsError('')
  }, [assetType, symbol, startDate, endDate, interval])

  const parsedDecisions = useMemo(() => parseDecisions(decisionsJson), [decisionsJson])
  const runIdError = validateRunId(runId)
  const cash = Number(initialCash)
  const maxHistoryValue = maxHistoryEntries.trim() ? Number(maxHistoryEntries) : null
  const maxHistoryError = mode === 'ai' && maxHistoryEntries.trim() && (!Number.isInteger(maxHistoryValue) || (maxHistoryValue ?? 0) <= 0)
    ? 'Max history entries must be a positive integer.'
    : ''
  const dateRangeError = startDate && endDate && startDate > endDate
    ? 'End date must be on or after start date.'
    : ''
  const createDisabled = submitting
    || bars.length === 0
    || !Number.isFinite(cash)
    || cash <= 0
    || !!runIdError
    || !!dateRangeError
    || !!maxHistoryError
    || (mode === 'ai' && !prompt.trim())
    || (mode === 'scripted' && !!parsedDecisions.error)

  const fetchBars = useCallback(async () => {
    setBarsLoading(true)
    setBarsError('')
    try {
      const result = await api.backtest.fetchBars({
        assetType,
        symbol: symbol.trim(),
        startDate,
        endDate,
        ...(assetType === 'crypto' && interval.trim() ? { interval: interval.trim() } : {}),
      })
      setBars(result.bars)
      if (result.bars.length === 0) {
        setBarsError('No bars returned for this query.')
      }
    } catch (err) {
      setBars([])
      setBarsError(asMessage(err))
    } finally {
      setBarsLoading(false)
    }
  }, [assetType, endDate, interval, startDate, symbol])

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    setSubmitError('')
    try {
      const body: BacktestStartRunRequest = {
        ...(runId.trim() ? { runId: runId.trim() } : {}),
        initialCash: cash,
        bars,
        strategy: mode === 'ai'
          ? {
              mode: 'ai',
              prompt: prompt.trim(),
              ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
              ...(maxHistoryValue ? { maxHistoryEntries: maxHistoryValue } : {}),
            }
          : {
              mode: 'scripted',
              decisions: parsedDecisions.value ?? [],
            },
      }
      const result = await api.backtest.startRun(body)
      await onCreated(result.runId)
    } catch (err) {
      setSubmitError(asMessage(err))
      setSubmitting(false)
    }
  }, [bars, cash, maxHistoryValue, mode, onCreated, parsedDecisions.value, prompt, runId, systemPrompt])

  const barsSummary = bars.length > 0
    ? `${bars.length} bars • ${formatDateTime(bars[0].ts)} → ${formatDateTime(bars[bars.length - 1].ts)}`
    : 'Fetch bars to enable run creation.'

  return (
    <Dialog onClose={onClose} width="w-[760px]">
      <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-border">
        <div>
          <h3 className="text-[15px] font-semibold text-text">New Backtest</h3>
          <p className="text-[12px] text-text-muted mt-1">Fetch replay bars, choose a strategy, then start a run.</p>
        </div>
        <button
          onClick={onClose}
          className="text-[12px] text-text-muted hover:text-text transition-colors"
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <Section title="Replay Data" description="Pull normalized bars for this backtest run.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Run ID (optional)">
              <input value={runId} onChange={(e) => setRunId(e.target.value)} className={inputClass} placeholder="bt-my-run" />
            </Field>
            <Field label="Initial Cash">
              <input value={initialCash} onChange={(e) => setInitialCash(e.target.value)} className={inputClass} inputMode="decimal" />
            </Field>
            <Field label="Asset Type">
              <select value={assetType} onChange={(e) => setAssetType(e.target.value as 'equity' | 'crypto')} className={inputClass}>
                <option value="equity">Equity</option>
                <option value="crypto">Crypto</option>
              </select>
            </Field>
            <Field label="Symbol">
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className={inputClass} placeholder="AAPL or BTCUSD" />
            </Field>
            <Field label="Start Date">
              <input value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} type="date" />
            </Field>
            <Field label="End Date">
              <input value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} type="date" />
            </Field>
            {assetType === 'crypto' && (
              <Field label="Interval">
                <input value={interval} onChange={(e) => setInterval(e.target.value)} className={inputClass} placeholder="1d, 1h, 5m" />
              </Field>
            )}
          </div>

          {runIdError && <p className="text-[12px] text-red mt-2">{runIdError}</p>}
          {dateRangeError && <p className="text-[12px] text-red mt-2">{dateRangeError}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={() => void fetchBars()}
              disabled={barsLoading || !!dateRangeError}
              className="px-3 py-1.5 text-[13px] font-medium rounded-md border border-border hover:bg-bg-tertiary disabled:opacity-50 transition-colors"
            >
              {barsLoading ? 'Fetching...' : 'Fetch Bars'}
            </button>
            <span className="text-[12px] text-text-muted">{barsSummary}</span>
          </div>
          {barsError && <p className="text-[12px] text-red mt-2">{barsError}</p>}
        </Section>

        <div className="mt-6">
          <Section title="Strategy" description="Choose AI-driven decisions or provide scripted operations.">
            <div className="flex items-center gap-2 mb-4">
              {(['ai', 'scripted'] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setMode(value)}
                  className={`px-3 py-1.5 text-[13px] rounded-md border transition-colors ${
                    mode === value
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border text-text-muted hover:text-text hover:bg-bg-tertiary'
                  }`}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>

            {mode === 'ai' ? (
              <>
                <Field label="Prompt">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className={`${inputClass} min-h-[120px] resize-y`}
                  />
                </Field>
                <Field label="System Prompt (optional)">
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    className={`${inputClass} min-h-[80px] resize-y`}
                  />
                </Field>
                <Field label="Max History Entries (optional)">
                  <input
                    value={maxHistoryEntries}
                    onChange={(e) => setMaxHistoryEntries(e.target.value)}
                    className={inputClass}
                    inputMode="numeric"
                  />
                </Field>
                {maxHistoryError && <p className="text-[12px] text-red -mt-1">{maxHistoryError}</p>}
              </>
            ) : (
              <>
                <Field label="Decisions JSON">
                  <textarea
                    value={decisionsJson}
                    onChange={(e) => setDecisionsJson(e.target.value)}
                    className={`${inputClass} min-h-[180px] resize-y font-mono`}
                    spellCheck={false}
                  />
                </Field>
                <p className="text-[12px] text-text-muted">
                  Expected format: an array of objects like {`{ "step": 1, "operations": [...] }`}.
                </p>
                {parsedDecisions.error && (
                  <p className="text-[12px] text-red mt-2">{parsedDecisions.error}</p>
                )}
              </>
            )}
          </Section>
        </div>

        {submitError && (
          <div className="mt-5 rounded-lg border border-red/40 bg-red/10 px-4 py-3 text-[13px] text-red">
            {submitError}
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center justify-between px-5 py-4 border-t border-border bg-bg-secondary">
        <p className="text-[12px] text-text-muted">
          {bars.length > 0 ? `${bars.length} bars ready for replay.` : 'Fetch bars before starting the run.'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[13px] font-medium rounded-md border border-border hover:bg-bg-tertiary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={createDisabled}
            className="px-3 py-1.5 text-[13px] font-medium rounded-md bg-accent text-bg disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {submitting ? 'Starting...' : 'Start Backtest'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function Dialog({ onClose, width, children }: {
  onClose: () => void
  width?: string
  children: ReactNode
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={`relative ${width ?? 'w-[560px]'} max-w-[95vw] max-h-[90vh] bg-bg rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col`}>
        {children}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: BacktestRunManifest['status'] }) {
  const klass = status === 'completed'
    ? 'bg-green/10 text-green'
    : status === 'failed'
      ? 'bg-red/10 text-red'
      : 'bg-accent/10 text-accent'

  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${klass}`}>
      {status}
    </span>
  )
}

function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={`rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-text-muted whitespace-pre-wrap break-all ${className ?? ''}`}>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function parseDecisions(input: string): { value: BacktestDecisionPlanEntry[] | null; error?: string } {
  try {
    const parsed = JSON.parse(input) as unknown
    if (!Array.isArray(parsed)) {
      return { value: null, error: 'Decisions JSON must be an array.' }
    }
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) {
        return { value: null, error: 'Each decision must be an object.' }
      }
      const decision = entry as { step?: unknown; operations?: unknown }
      if (typeof decision.step !== 'number' || !Array.isArray(decision.operations)) {
        return { value: null, error: 'Each decision needs numeric step and operations array.' }
      }
    }
    return { value: parsed as BacktestDecisionPlanEntry[] }
  } catch (err) {
    return { value: null, error: asMessage(err) }
  }
}

function validateRunId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!RUN_ID_PATTERN.test(trimmed) || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    return 'Run ID must use only letters, numbers, underscores, or hyphens.'
  }
  return ''
}

async function withNotFoundFallback<T>(fn: () => Promise<T>, fallback: T | null = null): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    const message = asMessage(err)
    if (message.includes('not found') || message.includes('Not found')) {
      return fallback
    }
    throw err
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatSignedMoney(value: number): string {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${formatMoney(value)}`
}

function formatPercent(value: number): string {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${(value * 100).toFixed(2)}%`
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
