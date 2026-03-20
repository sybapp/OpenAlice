import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  api,
  type EventLogEntry,
  type TraderWorkflowRunDetail,
  type TraderWorkflowRunSummary,
  type TraderWorkflowStage,
  type TraderWorkflowStageEntry,
} from '../api'
import { useSSE } from '../hooks/useSSE'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function stageLabel(stage: TraderWorkflowStage): string {
  switch (stage) {
    case 'market-scan': return 'Market Scan'
    case 'trade-thesis': return 'Trade Thesis'
    case 'risk-check': return 'Risk Check'
    case 'trade-plan': return 'Trade Plan'
    case 'trade-execute': return 'Execute Confirm'
    case 'trade-execute-script': return 'Execute Script'
  }
}

function runBadgeClass(status: TraderWorkflowRunSummary['status']): string {
  switch (status) {
    case 'done': return 'border-green/40 bg-green/12 text-green'
    case 'skip': return 'border-notification-border/40 bg-notification-bg/70 text-notification-border'
    case 'error': return 'border-red/40 bg-red/12 text-red'
    default: return 'border-accent/40 bg-accent/12 text-accent'
  }
}

function stageBadgeClass(status: TraderWorkflowStageEntry['status']): string {
  switch (status) {
    case 'completed': return 'border-green/40 bg-green/10 text-green'
    case 'skipped': return 'border-notification-border/40 bg-notification-bg/70 text-notification-border'
    case 'failed': return 'border-red/40 bg-red/10 text-red'
  }
}

function fieldGrid(fields: Array<[string, string | null]>) {
  const visible = fields.filter(([, value]) => value)
  if (visible.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {visible.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-border/60 bg-bg/70 px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
          <div className="text-sm text-text whitespace-pre-wrap break-words">{value}</div>
        </div>
      ))}
    </div>
  )
}

function renderMarketScan(data: Record<string, unknown>) {
  const summary = asString(data.summary)
  const candidates = Array.isArray(data.candidates) ? data.candidates.filter(isRecord) : []
  const evaluations = Array.isArray(data.evaluations) ? data.evaluations.filter(isRecord) : []

  return (
    <div className="space-y-3">
      {fieldGrid([['Summary', summary]])}
      {candidates.length > 0 && (
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">Candidates</div>
          <div className="grid gap-3">
            {candidates.map((candidate, index) => (
              <div key={`${asString(candidate.symbol) ?? 'candidate'}-${index}`} className="rounded-xl border border-border/60 bg-bg/70 px-3 py-3">
                <div className="text-sm font-semibold text-text">{asString(candidate.symbol) ?? 'Unknown symbol'}</div>
                <div className="mt-1 text-xs text-text-muted">{asString(candidate.source) ?? '-'}</div>
                <div className="mt-2 text-sm text-text">{asString(candidate.reason) ?? '-'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {evaluations.length > 0 && (
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">Evaluations</div>
          <div className="grid gap-3">
            {evaluations.map((evaluation, index) => (
              <div key={`${asString(evaluation.symbol) ?? 'evaluation'}-${index}`} className="rounded-xl border border-border/60 bg-bg/70 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-text">{asString(evaluation.symbol) ?? 'Unknown symbol'}</div>
                  <span className="rounded-full border border-border/60 bg-bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-text-muted">
                    {asString(evaluation.verdict) ?? 'unknown'}
                  </span>
                </div>
                <div className="mt-1 text-xs text-text-muted">{asString(evaluation.source) ?? '-'}</div>
                <div className="mt-2 text-sm text-text">{asString(evaluation.reason) ?? '-'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function renderOrders(data: Record<string, unknown>) {
  const orders = Array.isArray(data.orders) ? data.orders.filter(isRecord) : []
  if (orders.length === 0) return null
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">Orders</div>
      <div className="grid gap-3">
        {orders.map((order, index) => (
          <div key={`${asString(order.symbol) ?? 'order'}-${index}`} className="rounded-xl border border-border/60 bg-bg/70 px-3 py-3 text-sm text-text">
            <div className="font-semibold">{[asString(order.side), asString(order.type), asString(order.symbol)].filter(Boolean).join(' ')}</div>
            <div className="mt-1 text-text-muted">
              {[order.qty != null ? `qty=${String(order.qty)}` : null, order.stopPrice != null ? `stop=${String(order.stopPrice)}` : null, order.price != null ? `price=${String(order.price)}` : null].filter(Boolean).join(' • ') || '-'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function renderStageData(stage: TraderWorkflowStageEntry): ReactNode {
  const data = isRecord(stage.data) ? stage.data : {}

  switch (stage.stage) {
    case 'market-scan':
      return renderMarketScan(data)
    case 'trade-thesis':
      return (
        <div className="space-y-3">
          {fieldGrid([
            ['Source', asString(data.source)],
            ['Symbol', asString(data.symbol)],
            ['Bias', asString(data.bias)],
            ['Scenario', asString(data.chosenScenario)],
            ['Rationale', asString(data.rationale)],
          ])}
          {asStringArray(data.invalidation).length > 0 && (
            <div className="rounded-xl border border-border/60 bg-bg/70 px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">Invalidation</div>
              <div className="space-y-2 text-sm text-text">
                {asStringArray(data.invalidation).map((line) => <div key={line}>{line}</div>)}
              </div>
            </div>
          )}
        </div>
      )
    case 'risk-check':
      return fieldGrid([
        ['Verdict', asString(data.verdict)],
        ['Rationale', asString(data.rationale)],
        ['Max Risk %', data.maxRiskPercent != null ? String(data.maxRiskPercent) : null],
      ]) ?? <div />
    case 'trade-plan':
      return (
        <div className="space-y-3">
          {fieldGrid([
            ['Status', asString(data.status)],
            ['Scenario', asString(data.chosenScenario)],
            ['Rationale', asString(data.rationale)],
            ['Commit Message', asString(data.commitMessage)],
          ])}
          {renderOrders(data)}
        </div>
      )
    case 'trade-execute':
      return fieldGrid([
        ['Status', asString(data.status)],
        ['Rationale', asString(data.rationale)],
        ['Brain Update', asString(data.brainUpdate)],
      ]) ?? <div />
    case 'trade-execute-script': {
      const outcome = isRecord(data.outcome) ? data.outcome : {}
      return (
        <div className="space-y-3">
          {fieldGrid([
            ['Source', asString(data.source)],
            ['Symbol', asString(data.symbol)],
            ['Commit Message', asString(data.commitMessage)],
            ['Outcome', asString(outcome.rationale)],
            ['Filled', outcome.filledCount != null ? String(outcome.filledCount) : null],
            ['Pending', outcome.pendingCount != null ? String(outcome.pendingCount) : null],
            ['Rejected', outcome.rejectedCount != null ? String(outcome.rejectedCount) : null],
          ])}
          {asStringArray(outcome.actionsTaken).length > 0 && (
            <div className="rounded-xl border border-border/60 bg-bg/70 px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">Actions Taken</div>
              <div className="space-y-2 text-sm text-text">
                {asStringArray(outcome.actionsTaken).map((line) => <div key={line}>{line}</div>)}
              </div>
            </div>
          )}
        </div>
      )
    }
  }
}

function renderTerminalCard(event: EventLogEntry | null) {
  if (!event || !isRecord(event.payload)) return null
  const payload = event.payload
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/85 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-[0.16em] text-text-muted">Terminal Event</span>
        <span className="rounded-full border border-border/60 bg-bg px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-text">
          {event.type}
        </span>
      </div>
      {fieldGrid([
        ['Reason', asString(payload.reason)],
        ['Error', asString(payload.error)],
        ['At', formatDateTime(event.ts)],
      ])}
    </div>
  )
}

export function WorkflowsPage() {
  const [runs, setRuns] = useState<TraderWorkflowRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TraderWorkflowRunDetail | null>(null)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [detailError, setDetailError] = useState('')

  const loadRuns = useCallback(async () => {
    setRunsError('')
    setLoadingRuns(true)
    try {
      const result = await api.workflows.listTraderRuns({ page: 1, pageSize: 30 })
      setRuns(result.entries)
      setSelectedRunId((current) => {
        if (current && result.entries.some((entry) => entry.runId === current)) return current
        return result.entries[0]?.runId ?? null
      })
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : 'Failed to load workflows')
    } finally {
      setLoadingRuns(false)
    }
  }, [])

  const loadDetail = useCallback(async (runId: string) => {
    setDetailError('')
    setLoadingDetail(true)
    try {
      setDetail(await api.workflows.getTraderRun(runId))
    } catch (error) {
      setDetail(null)
      setDetailError(error instanceof Error ? error.message : 'Failed to load workflow detail')
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  useEffect(() => {
    loadRuns().catch((error) => console.warn('Failed to load workflows:', error))
  }, [loadRuns])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null)
      return
    }
    loadDetail(selectedRunId).catch((error) => console.warn('Failed to load workflow detail:', error))
  }, [loadDetail, selectedRunId])

  useSSE({
    url: '/api/events/stream',
    onMessage: (entry) => {
      if (!entry || typeof entry.type !== 'string' || !entry.type.startsWith('trader.')) return
      const payload = isRecord(entry.payload) ? entry.payload : null
      const runId = payload ? asString(payload.runId) : null
      loadRuns().catch((error) => console.warn('Failed to refresh workflows:', error))
      if (selectedRunId && runId === selectedRunId) {
        loadDetail(selectedRunId).catch((error) => console.warn('Failed to refresh workflow detail:', error))
      }
    },
  })

  const selectedRun = useMemo(
    () => runs.find((entry) => entry.runId === selectedRunId) ?? detail?.summary ?? null,
    [detail?.summary, runs, selectedRunId],
  )

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="border-b border-border bg-bg-secondary/80 px-6 py-5">
        <div className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Trader Workflows</div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text">Workflow Trace</h1>
            <p className="mt-1 max-w-3xl text-sm text-text-muted">
              Inspect each trader run as a step-by-step timeline and see exactly where the pipeline stopped.
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-bg px-4 py-3 text-right">
            <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Visible Runs</div>
            <div className="mt-1 text-2xl font-semibold text-text">{runs.length}</div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="border-r border-border bg-bg-secondary/45">
            <div className="border-b border-border px-4 py-3 text-xs uppercase tracking-[0.16em] text-text-muted">
              Recent Runs
            </div>
            <div className="h-[calc(100%-49px)] overflow-y-auto px-3 py-3">
              {loadingRuns ? (
                <div className="rounded-2xl border border-border/60 bg-bg px-4 py-6 text-sm text-text-muted">Loading workflows...</div>
              ) : runsError ? (
                <div className="rounded-2xl border border-red/40 bg-red/8 px-4 py-6 text-sm text-red">{runsError}</div>
              ) : runs.length === 0 ? (
                <div className="rounded-2xl border border-border/60 bg-bg px-4 py-6 text-sm text-text-muted">No trader runs yet.</div>
              ) : (
                <div className="space-y-3">
                  {runs.map((run) => {
                    const active = run.runId === selectedRunId
                    return (
                      <button
                        key={run.runId}
                        type="button"
                        onClick={() => setSelectedRunId(run.runId)}
                        className={`w-full rounded-2xl border px-4 py-4 text-left transition ${active ? 'border-accent/60 bg-accent/10 shadow-sm' : 'border-border/70 bg-bg hover:border-border hover:bg-bg-secondary/80'}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-text">{run.strategyId}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${runBadgeClass(run.status)}`}>
                            {run.status}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-text-muted">{run.jobName ?? run.jobId}</div>
                        <div className="mt-3 grid gap-2 text-xs text-text-muted">
                          <div>Ended at: {run.endedStage ? stageLabel(run.endedStage) : 'Not reached'}</div>
                          <div>{timeAgo(run.startedAt)} • {run.durationMs != null ? `${Math.round(run.durationMs / 1000)}s` : 'running'}</div>
                        </div>
                        <div className="mt-3 text-sm text-text line-clamp-3">{run.headline}</div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto bg-bg px-6 py-6">
            {!selectedRun ? (
              <div className="rounded-3xl border border-dashed border-border px-6 py-12 text-center text-text-muted">
                Select a run to inspect its workflow.
              </div>
            ) : loadingDetail ? (
              <div className="rounded-3xl border border-border bg-bg-secondary/70 px-6 py-12 text-center text-text-muted">
                Loading workflow detail...
              </div>
            ) : detailError ? (
              <div className="rounded-3xl border border-red/40 bg-red/8 px-6 py-12 text-center text-red">
                {detailError}
              </div>
            ) : detail ? (
              <div className="space-y-5">
                <div className="rounded-3xl border border-border bg-[linear-gradient(135deg,rgba(61,115,255,0.08),rgba(255,255,255,0.02))] p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Run {detail.summary.runId}</div>
                      <h2 className="mt-2 text-2xl font-semibold text-text">{detail.summary.strategyId}</h2>
                      <div className="mt-2 text-sm text-text-muted">{detail.summary.jobName ?? detail.summary.jobId}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.14em] ${runBadgeClass(detail.summary.status)}`}>
                        {detail.summary.status}
                      </span>
                      <span className="rounded-full border border-border/70 bg-bg/80 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-text-muted">
                        Ended at {detail.summary.endedStage ? stageLabel(detail.summary.endedStage) : 'preflight'}
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-4">
                    <div className="rounded-2xl border border-border/60 bg-bg/70 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Started</div>
                      <div className="mt-1 text-sm text-text">{formatDateTime(detail.summary.startedAt)}</div>
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-bg/70 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Ended</div>
                      <div className="mt-1 text-sm text-text">{detail.summary.endedAt ? formatDateTime(detail.summary.endedAt) : 'In progress'}</div>
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-bg/70 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Duration</div>
                      <div className="mt-1 text-sm text-text">{detail.summary.durationMs != null ? `${Math.round(detail.summary.durationMs / 1000)}s` : '-'}</div>
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-bg/70 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Headline</div>
                      <div className="mt-1 text-sm text-text">{detail.summary.headline}</div>
                    </div>
                  </div>
                </div>

                {detail.stages.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-border px-6 py-10 text-center text-text-muted">
                    No stage events were captured for this run.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {detail.stages.map((stage, index) => (
                      <div key={`${stage.seq}-${stage.stage}`} className="rounded-3xl border border-border bg-bg-secondary/70 p-5 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Step {index + 1}</div>
                            <h3 className="mt-1 text-xl font-semibold text-text">{stageLabel(stage.stage)}</h3>
                            <div className="mt-1 text-sm text-text-muted">{formatDateTime(stage.ts)} • {timeAgo(stage.ts)}</div>
                          </div>
                          <span className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.14em] ${stageBadgeClass(stage.status)}`}>
                            {stage.status}
                          </span>
                        </div>
                        <div className="mt-4">
                          {renderStageData(stage)}
                        </div>
                        <details className="mt-4 rounded-2xl border border-border/60 bg-bg/60 px-4 py-3">
                          <summary className="cursor-pointer text-[11px] uppercase tracking-[0.14em] text-text-muted">
                            Raw JSON
                          </summary>
                          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-text-muted">
                            {JSON.stringify(stage.data, null, 2)}
                          </pre>
                        </details>
                      </div>
                    ))}
                  </div>
                )}

                {renderTerminalCard(detail.terminalEvent)}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}
