import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Field, inputClass } from '../components/form'
import { SDKSelector } from '../components/SDKSelector'
import type { SDKOption } from '../components/SDKSelector'
import { useTradingConfig } from '../hooks/useTradingConfig'
import { useAccountHealth } from '../hooks/useAccountHealth'
import { useSchemaForm } from '../hooks/useSchemaForm'
import { PageHeader } from '../components/PageHeader'
import { Dialog } from '../components/uta/Dialog'
import { HealthBadge } from '../components/uta/HealthBadge'
import { SchemaFormFields } from '../components/uta/SchemaFormFields'
import { Metric, signFromDelta } from '../components/Metric'
import { Sparkline } from '../components/Sparkline'
import { fmt, fmtPnl, fmtPctSigned } from '../lib/format'
import { api } from '../api'
import type { TradeSetup } from '../api/trading'
import type { UTAConfig, BrokerPreset, BrokerHealthInfo, TestConnectionResult, Position, AccountInfo, EquityCurvePoint } from '../api/types'

type SignalAwareTradeSetup = Omit<TradeSetup, 'source'> & {
  provenance?: {
    source?: string
    provider?: string
    generatedAt?: string
    inputHash?: string
    dataHash?: string
    signalRunId?: string
    signalHash?: string
    contentHash?: string
    [key: string]: unknown
  }
  riskTemplate?: string | { id?: string; name?: string; label?: string; [key: string]: unknown }
  contentHash?: string
  signalHash?: string
  source: TradeSetup['source'] | { type: 'signal_engine' | string; alertRunId?: string; signalRunId?: string; runId?: string }
}

type SetupStatusFilter = 'actionable' | TradeSetup['status'] | 'all'
type SetupSourceFilter = 'all' | 'signal_engine' | 'market_data_alert'

const SETUP_STATUS_FILTERS: Array<{ value: SetupStatusFilter; label: string }> = [
  { value: 'actionable', label: 'Actionable' },
  { value: 'draft', label: 'Draft' },
  { value: 'failed', label: 'Failed' },
  { value: 'committed', label: 'Committed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
]

const SETUP_SOURCE_FILTERS: Array<{ value: SetupSourceFilter; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'signal_engine', label: 'Signal Engine' },
  { value: 'market_data_alert', label: 'Market Alerts' },
]

// ==================== Live equity (across all UTAs) ====================

interface EquitySummary {
  totalEquity: string
  totalCash: string
  totalUnrealizedPnL: string
  totalRealizedPnL: string
  accounts: Array<{ id: string; label: string; equity: string; cash: string }>
}

interface PerUtaCurve { values: number[]; firstAtCutoff: number | null; latest: number | null }

interface CurveSummary {
  /** Aggregate (across all UTAs) — feeds the hero banner. */
  total: { values: number[]; firstAtCutoff: number | null; latest: number | null }
  /** Per-UTA curves — feed the per-card sparkline + 24h delta. */
  perUta: Record<string, PerUtaCurve>
}

const CUTOFF_24H_MS = 24 * 60 * 60 * 1000

/** Build a curve summary from equity-curve points: latest value + the
 *  oldest value still within the trailing 24h window (the "baseline"
 *  for today PnL). */
function summarizeCurve(points: EquityCurvePoint[]): CurveSummary {
  const sorted = [...points].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const cutoff = Date.now() - CUTOFF_24H_MS

  const totalValues: number[] = []
  let totalFirstAtCutoff: number | null = null
  let totalLatest: number | null = null
  const perUtaValues = new Map<string, number[]>()
  const perUtaFirstAtCutoff = new Map<string, number>()
  const perUtaLatest = new Map<string, number>()

  for (const p of sorted) {
    const t = new Date(p.timestamp).getTime()
    const totalN = Number(p.equity)
    if (Number.isFinite(totalN)) {
      totalValues.push(totalN)
      totalLatest = totalN
      if (t >= cutoff && totalFirstAtCutoff == null) totalFirstAtCutoff = totalN
    }
    for (const [id, raw] of Object.entries(p.accounts ?? {})) {
      const n = Number(raw)
      if (!Number.isFinite(n)) continue
      let arr = perUtaValues.get(id)
      if (!arr) { arr = []; perUtaValues.set(id, arr) }
      arr.push(n)
      perUtaLatest.set(id, n)
      if (t >= cutoff && !perUtaFirstAtCutoff.has(id)) perUtaFirstAtCutoff.set(id, n)
    }
  }

  const perUta: Record<string, PerUtaCurve> = {}
  for (const [id, values] of perUtaValues) {
    perUta[id] = {
      values,
      firstAtCutoff: perUtaFirstAtCutoff.get(id) ?? null,
      latest: perUtaLatest.get(id) ?? null,
    }
  }

  return {
    total: { values: totalValues, firstAtCutoff: totalFirstAtCutoff, latest: totalLatest },
    perUta,
  }
}

// ==================== Page ====================

export function TradingPage() {
  const tc = useTradingConfig()
  const healthMap = useAccountHealth()
  const navigate = useNavigate()
  const [showAdd, setShowAdd] = useState(false)
  const [presets, setPresets] = useState<BrokerPreset[]>([])
  const [equity, setEquity] = useState<EquitySummary | null>(null)
  const [curve, setCurve] = useState<CurveSummary | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [setups, setSetups] = useState<TradeSetup[]>([])
  const [setupAction, setSetupAction] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)

  const refreshSetups = useCallback(async () => {
    const result = await api.trading.tradeSetups({ limit: 50 })
    setSetups(result.entries)
  }, [])

  // Live aggregates: pull `equity()` for headline numbers and `equityCurve()`
  // for trend + 24h delta. One fetch each per cycle, shared across the
  // hero banner + every UTA card. Polling cadence (30s) is informational —
  // user can drill into a UTA for the 15s refresh of broker state.
  const refreshAggregates = useCallback(async () => {
    try {
      const [eq, cv] = await Promise.all([
        api.trading.equity().catch(() => null),
        api.trading.equityCurve({ limit: 1500 }).catch(() => ({ points: [] as EquityCurvePoint[] })),
      ])
      if (eq) setEquity(eq)
      setCurve(summarizeCurve(cv.points))
      setLastUpdated(new Date())
    } catch {
      // Don't surface — aggregates are nice-to-have, the page still renders
      // from useTradingConfig if the equity endpoint is down.
    }
  }, [])

  useEffect(() => {
    api.trading.getBrokerPresets().then(r => setPresets(r.presets)).catch(() => {})
    refreshSetups().catch(() => {})
  }, [refreshSetups])

  useEffect(() => {
    refreshAggregates()
    const id = setInterval(refreshAggregates, 30_000)
    return () => clearInterval(id)
  }, [refreshAggregates])

  const stageSetup = async (setupId: string) => {
    setSetupAction(setupId)
    setSetupError(null)
    try {
      const result = await api.trading.stageTradeSetup(setupId)
      if (!result.ok) throw new Error(result.error ?? 'Stage setup failed')
      await refreshSetups()
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err))
    } finally {
      setSetupAction(null)
    }
  }

  const rejectSetup = async (setupId: string) => {
    setSetupAction(setupId)
    setSetupError(null)
    try {
      const result = await api.trading.rejectTradeSetup(setupId, 'rejected in Trading page')
      if (!result.ok) throw new Error(result.error ?? 'Reject setup failed')
      await refreshSetups()
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err))
    } finally {
      setSetupAction(null)
    }
  }

  if (tc.loading) return <PageShell subtitle="Loading..." />
  if (tc.error) {
    return (
      <PageShell subtitle="Failed to load trading configuration.">
        <p className="text-[13px] text-red">{tc.error}</p>
        <button onClick={tc.refresh} className="mt-2 btn-secondary">Retry</button>
      </PageShell>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title="Trading"
        description="Configure your UTAs (Unified Trading Accounts)."
        live={tc.utas.length > 0 ? { lastUpdated } : undefined}
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[820px] mx-auto space-y-4">
          <TradeSetupPanel
            setups={setups}
            action={setupAction}
            error={setupError}
            onStage={stageSetup}
            onReject={rejectSetup}
          />

          {tc.utas.length === 0 ? (
            <EmptyState onAdd={() => setShowAdd(true)} />
          ) : (
            <>
              {equity && <PortfolioBanner equity={equity} curve={curve?.total ?? null} />}

              <div className="space-y-2.5">
                {tc.utas.map((uta) => {
                  const equityRow = equity?.accounts.find(a => a.id === uta.id) ?? null
                  return (
                    <UTACard
                      key={uta.id}
                      uta={uta}
                      preset={presets.find(p => p.id === uta.presetId)}
                      health={healthMap[uta.id]}
                      equity={equityRow}
                      curve={curve?.perUta[uta.id] ?? null}
                      onClick={() => navigate(`/uta/${uta.id}`)}
                    />
                  )
                })}
                <button
                  onClick={() => setShowAdd(true)}
                  className="w-full py-2.5 text-[12px] text-text-muted hover:text-text border border-dashed border-border hover:border-text-muted/40 rounded-lg transition-colors"
                >
                  + Add UTA
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {showAdd && (
        <CreateWizard
          presets={presets}
          onSave={async (uta) => {
            const created = await tc.createUTA(uta)
            const result = await tc.reconnectUTA(created.id)
            if (!result.success) {
              throw new Error(result.error || 'Connection failed')
            }
            setShowAdd(false)
            // Trigger a fresh fetch so the new UTA shows live numbers right away.
            void refreshAggregates()
            return created
          }}
          onOpenExisting={(id) => {
            setShowAdd(false)
            navigate(`/uta/${id}`)
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  )
}

function TradeSetupPanel({
  setups,
  action,
  error,
  onStage,
  onReject,
}: {
  setups: TradeSetup[]
  action: string | null
  error: string | null
  onStage: (setupId: string) => void
  onReject: (setupId: string) => void
}) {
  const [statusFilter, setStatusFilter] = useState<SetupStatusFilter>('actionable')
  const [sourceFilter, setSourceFilter] = useState<SetupSourceFilter>('all')
  const [symbolQuery, setSymbolQuery] = useState('')
  const [accountFilter, setAccountFilter] = useState('all')
  const active = setups.filter((setup) => setup.status === 'draft' || setup.status === 'failed')
  const accounts = useMemo(() => {
    const values = new Set<string>()
    for (const setup of setups) {
      if (setup.order.source) values.add(setup.order.source)
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [setups])
  const filtered = useMemo(() => {
    const query = symbolQuery.trim().toUpperCase()
    return setups
      .filter((setup) => {
        if (statusFilter === 'actionable') return setup.status === 'draft' || setup.status === 'failed'
        if (statusFilter === 'all') return true
        return setup.status === statusFilter
      })
      .filter((setup) => sourceFilter === 'all' || setup.source.type === sourceFilter)
      .filter((setup) => accountFilter === 'all' || setup.order.source === accountFilter)
      .filter((setup) => !query || setup.symbol.toUpperCase().includes(query) || setup.order.aliceId.toUpperCase().includes(query))
  }, [accountFilter, setups, sourceFilter, statusFilter, symbolQuery])

  if (setups.length === 0) return null
  return (
    <section className="rounded-lg border border-border bg-bg-secondary/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-text">Trade Setups</h3>
          <p className="text-[11px] text-text-muted">Review setups here; final broker push stays in the approval panel.</p>
        </div>
        <span className="text-[11px] text-text-muted">{active.length} actionable · {filtered.length} shown</span>
      </div>
      {error && <p className="text-[12px] text-red">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_150px_150px_150px] gap-2">
        <input
          className="px-2.5 py-1.5 bg-bg text-text border border-border rounded-md text-[12px] outline-none focus:border-accent"
          value={symbolQuery}
          onChange={(e) => setSymbolQuery(e.target.value)}
          placeholder="Search symbol or aliceId"
        />
        <SetupSelect value={statusFilter} onChange={(value) => setStatusFilter(value as SetupStatusFilter)}>
          {SETUP_STATUS_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </SetupSelect>
        <SetupSelect value={sourceFilter} onChange={(value) => setSourceFilter(value as SetupSourceFilter)}>
          {SETUP_SOURCE_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </SetupSelect>
        <SetupSelect value={accountFilter} onChange={setAccountFilter}>
          <option value="all">All accounts</option>
          {accounts.map((account) => <option key={account} value={account}>{account}</option>)}
        </SetupSelect>
      </div>
      {filtered.length === 0 ? (
        <p className="rounded-md border border-border/40 bg-bg/30 px-2.5 py-3 text-[12px] text-text-muted">No setups match the current filters.</p>
      ) : (
        filtered.slice(0, 20).map((setup) => (
          <TradeSetupCard
            key={setup.setupId}
            setup={setup}
            action={action}
            onStage={onStage}
            onReject={onReject}
          />
        ))
      )}
    </section>
  )
}

function SetupSelect({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <select
      className="px-2.5 py-1.5 bg-bg text-text border border-border rounded-md text-[12px] outline-none focus:border-accent"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  )
}

function TradeSetupCard({
  setup,
  action,
  onStage,
  onReject,
}: {
  setup: TradeSetup
  action: string | null
  onStage: (setupId: string) => void
  onReject: (setupId: string) => void
}) {
  const committed = setup.status === 'committed'
  return (
    <details className="rounded-md border border-border/50 bg-bg/40 px-2.5 py-2 text-[12px]">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-text">{setup.symbol}</span>
          <DirectionPill direction={setup.direction} />
          <StatusPill status={setup.status} />
          <span className="text-text-muted">{setup.order.source}</span>
          <span className="text-text-muted">{setup.order.action} {setup.order.orderType}</span>
          <SetupChip label={setup.source.type === 'signal_engine' ? 'signal' : 'alert'} value={sourceId(setup)} mono />
          {setup.commitHash && <SetupChip label="commit" value={setup.commitHash} mono />}
        </div>
        <p className="mt-1 text-text-muted/80 line-clamp-2">{setup.thesis}</p>
      </summary>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {setupProvenanceChips(setup).map((chip) => (
          <SetupChip key={chip.label} label={chip.label} value={chip.value} />
        ))}
        {riskTemplateLabel(setup) && <SetupChip label="risk" value={riskTemplateLabel(setup)!} />}
        {setupHashChips(setup).map((chip) => (
          <SetupChip key={`${chip.label}:${chip.value}`} label={chip.label} value={chip.value} mono />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-2">
        <SetupDetailSection title="Review">
          <SetupDetailRow label="Thesis" value={setup.thesis} />
          <SetupDetailRow label="Invalidation" value={setup.invalidation} />
          {setup.riskNotes && <SetupDetailRow label="Risk notes" value={setup.riskNotes} />}
          {setup.error && <SetupDetailRow label="Error" value={setup.error} tone="error" />}
          {setup.signals && setup.signals.length > 0 && (
            <div className="mt-2 space-y-1">
              {setup.signals.slice(0, 5).map((signal) => (
                <div key={signal.id} className="rounded bg-bg-tertiary/60 px-2 py-1">
                  <div className="font-medium text-text">{signal.label}</div>
                  <div className="text-text-muted/70">{signal.message}</div>
                </div>
              ))}
            </div>
          )}
        </SetupDetailSection>

        <SetupDetailSection title="Order">
          <SetupDetailRow label="aliceId" value={setup.order.aliceId} mono />
          <SetupDetailRow label="Account" value={setup.order.source} />
          <SetupDetailRow label="Action" value={`${setup.order.action} ${setup.order.orderType}`} />
          <SetupDetailRow label="Quantity" value={setup.order.totalQuantity ?? setup.order.cashQty} />
          <SetupDetailRow label="Limit" value={setup.order.lmtPrice} />
          <SetupDetailRow label="Stop loss" value={setup.order.stopLoss ? stopLossText(setup.order.stopLoss) : undefined} />
          <SetupDetailRow label="Take profit" value={setup.order.takeProfit?.price} />
          <SetupDetailRow label="TIF" value={setup.order.tif} />
        </SetupDetailSection>

        <SetupDetailSection title="Provenance">
          <SetupDetailRow label="Source" value={setup.source.type} />
          <SetupDetailRow label="Run" value={sourceId(setup)} mono />
          {setup.source.type === 'signal_engine' && (
            <>
              <SetupDetailRow label="Signal" value={setup.source.signalId} mono />
              <SetupDetailRow label="Strategy" value={`${setup.source.strategyId ?? 'unknown'}@${setup.source.strategyVersion ?? '?'}`} />
              <SetupDetailRow label="Engine" value={setup.source.engineVersion} />
              <SetupDetailRow label="Closed bar" value={setup.source.closedBarTime ? shortDateTime(setup.source.closedBarTime) : undefined} />
            </>
          )}
          <SetupDetailRow label="Source hash" value={setup.provenance?.sourceHash} mono />
          <SetupDetailRow label="Payload hash" value={setup.provenance?.canonicalPayloadHash} mono />
          <SetupDetailRow label="Eligibility" value={eligibilityText(setup)} />
        </SetupDetailSection>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          className="px-2.5 py-1 text-[12px] border border-border rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary disabled:opacity-50"
          disabled={action !== null || setup.status !== 'draft'}
          onClick={() => onStage(setup.setupId)}
        >
          {action === setup.setupId ? 'Working' : 'Stage Pending Trade'}
        </button>
        <button
          className="px-2.5 py-1 text-[12px] border border-border rounded-md text-text-muted hover:text-red hover:bg-red/10 disabled:opacity-50"
          disabled={action !== null || setup.status === 'committed' || setup.status === 'rejected'}
          onClick={() => onReject(setup.setupId)}
        >
          Reject
        </button>
        {committed && <span className="text-[11px] text-accent">Ready for manual Approve & Push in the trading approval panel.</span>}
      </div>
    </details>
  )
}

function SetupDetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border/40 px-2 py-2">
      <div className="text-[11px] uppercase text-text-muted/60">{title}</div>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  )
}

function SetupDetailRow({ label, value, mono, tone }: { label: string; value?: string | number | null; mono?: boolean; tone?: 'error' }) {
  if (value == null || value === '') return null
  return (
    <div className="grid grid-cols-[78px_1fr] gap-2">
      <span className="text-text-muted/60">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${tone === 'error' ? 'text-red' : 'text-text-muted/90'} break-words`}>{String(value)}</span>
    </div>
  )
}

function SetupChip({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className={`rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-muted ${mono ? 'font-mono text-accent' : ''}`}>
      {label}:{mono ? shortChip(value) : value}
    </span>
  )
}

function DirectionPill({ direction }: { direction: TradeSetup['direction'] }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] ${direction === 'bullish' ? 'bg-green/10 text-green' : 'bg-red/10 text-red'}`}>
      {direction}
    </span>
  )
}

function StatusPill({ status }: { status: TradeSetup['status'] }) {
  const cls = status === 'draft'
    ? 'bg-accent/10 text-accent'
    : status === 'failed'
      ? 'bg-red/10 text-red'
      : status === 'committed'
        ? 'bg-green/10 text-green'
        : 'bg-bg-tertiary text-text-muted'
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{status}</span>
}

function setupHashChips(setup: TradeSetup): Array<{ label: string; value: string }> {
  const signalSetup = setup as SignalAwareTradeSetup
  const chips = [
    signalSetup.contentHash ? { label: 'setup', value: signalSetup.contentHash } : null,
    signalSetup.signalHash ? { label: 'signal', value: signalSetup.signalHash } : null,
    signalSetup.provenance?.contentHash ? { label: 'content', value: String(signalSetup.provenance.contentHash) } : null,
    signalSetup.provenance?.signalHash ? { label: 'signal', value: String(signalSetup.provenance.signalHash) } : null,
    signalSetup.provenance?.inputHash ? { label: 'input', value: String(signalSetup.provenance.inputHash) } : null,
    signalSetup.provenance?.dataHash ? { label: 'data', value: String(signalSetup.provenance.dataHash) } : null,
  ].filter((chip): chip is { label: string; value: string } => Boolean(chip))
  const seen = new Set<string>()
  return chips.filter((chip) => {
    const key = `${chip.label}:${chip.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sourceId(setup: TradeSetup): string {
  if (setup.source.type === 'signal_engine') return setup.source.signalRunId
  return setup.source.alertRunId
}

function setupProvenanceChips(setup: TradeSetup): Array<{ label: string; value: string }> {
  const signalSetup = setup as SignalAwareTradeSetup
  const provenance = signalSetup.provenance ?? {}
  const sourceRun = signalSourceField(signalSetup.source, 'signalRunId') ?? signalSourceField(signalSetup.source, 'runId') ?? provenance.signalRunId ?? signalSourceField(signalSetup.source, 'alertRunId')
  return [
    sourceRun ? { label: signalSetup.source.type === 'signal_engine' ? 'run' : 'alert', value: shortChip(String(sourceRun)) } : null,
    provenance.source ? { label: 'source', value: String(provenance.source) } : null,
    provenance.provider ? { label: 'provider', value: String(provenance.provider) } : null,
    provenance.generatedAt ? { label: 'generated', value: shortDateTime(String(provenance.generatedAt)) } : null,
  ].filter((chip): chip is { label: string; value: string } => Boolean(chip))
}

function signalSourceField(source: SignalAwareTradeSetup['source'], key: 'signalRunId' | 'runId' | 'alertRunId'): string | undefined {
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function riskTemplateLabel(setup: TradeSetup): string | null {
  const template = (setup as SignalAwareTradeSetup).riskTemplate
  if (!template) {
    const riskId = setup.provenance?.riskTemplateId
    const riskVersion = setup.provenance?.riskTemplateVersion
    return riskId ? `${riskId}${riskVersion ? `@${riskVersion}` : ''}` : null
  }
  if (typeof template === 'string') return template
  return template.label ?? template.name ?? template.id ?? null
}

function stopLossText(stopLoss: NonNullable<TradeSetup['order']['stopLoss']>): string {
  return stopLoss.limitPrice ? `${stopLoss.price} / limit ${stopLoss.limitPrice}` : stopLoss.price
}

function eligibilityText(setup: TradeSetup): string | null {
  const eligibility = setup.provenance?.accountEligibility
  if (!eligibility) return null
  const mode = eligibility.resolvedMode ?? 'unknown'
  const account = eligibility.accountId ?? setup.order.source
  const allowed = eligibility.allowedModes?.join(', ') ?? 'simulator, paper'
  return `${account}: ${mode}; allowed ${allowed}`
}

function shortChip(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function shortDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ==================== Page Shell ====================

function PageShell({ subtitle, children }: { subtitle: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Trading" description={subtitle} />
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">{children}</div>
    </div>
  )
}

// ==================== Empty State ====================

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-12 text-center">
      <h3 className="text-[16px] font-semibold text-text mb-2">No UTAs configured</h3>
      <p className="text-[13px] text-text-muted mb-6 max-w-[320px] mx-auto leading-relaxed">
        Connect a crypto exchange or brokerage to start automated trading.
      </p>
      <button onClick={onAdd} className="btn-primary">
        + Add UTA
      </button>
    </div>
  )
}

// ==================== Portfolio banner (hero) ====================

function PortfolioBanner({ equity, curve }: {
  equity: EquitySummary
  curve: { values: number[]; firstAtCutoff: number | null; latest: number | null } | null
}) {
  const total = Number(equity.totalEquity)
  const cash = Number(equity.totalCash)
  const unrealized = Number(equity.totalUnrealizedPnL)

  // 24h delta from the curve summary. If curve is empty or the cutoff
  // baseline isn't available (UTA freshly added), suppress the delta.
  let deltaNode: React.ReactNode = null
  if (curve && curve.latest != null && curve.firstAtCutoff != null) {
    const delta = curve.latest - curve.firstAtCutoff
    const pct = curve.firstAtCutoff !== 0 ? (delta / curve.firstAtCutoff) * 100 : 0
    const sign = signFromDelta(delta)
    const arrow = sign === 'up' ? '▲' : sign === 'down' ? '▼' : '·'
    const color = sign === 'up' ? 'text-green' : sign === 'down' ? 'text-red' : 'text-text-muted'
    deltaNode = (
      <span className={`text-[14px] tabular-nums ${color}`}>
        {arrow} {fmtPnl(delta, 'USD')} ({fmtPctSigned(pct)}) today
      </span>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-5 py-4">
      <p className="text-[11px] text-text-muted uppercase tracking-wide mb-1">Total Portfolio · USD</p>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[26px] md:text-[30px] font-bold tabular-nums text-text">
          {fmt(total, 'USD')}
        </span>
        {deltaNode}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-muted">
        <span>Cash <span className="text-text tabular-nums">{fmt(cash, 'USD')}</span></span>
        <span className="text-text-muted/40">·</span>
        <span>Unrealized <span className={`tabular-nums ${unrealized >= 0 ? 'text-green' : 'text-red'}`}>{fmtPnl(unrealized, 'USD')}</span></span>
      </div>
    </div>
  )
}

// ==================== Subtitle builder ====================

function buildSubtitle(uta: UTAConfig, preset?: BrokerPreset): string {
  if (!preset) return uta.presetId
  const pc = uta.presetConfig
  const parts: string[] = []
  for (const sf of preset.subtitleFields) {
    const val = pc[sf.field]
    if (typeof val === 'boolean') {
      if (val && sf.label) parts.push(sf.label)
      else if (!val && sf.falseLabel) parts.push(sf.falseLabel)
    } else if (val != null && val !== '') {
      let display = String(val)
      if (sf.field === 'mode' && preset.modes) {
        const mode = preset.modes.find(m => m.id === val)
        if (mode) display = mode.label
      }
      parts.push(`${sf.prefix ?? ''}${display}`)
    }
  }
  return parts.join(' · ') || preset.label
}

// ==================== UTA Card ====================

function UTACard({ uta, preset, health, equity, curve, onClick }: {
  uta: UTAConfig
  preset?: BrokerPreset
  health?: BrokerHealthInfo
  equity?: { equity: string; cash: string } | null
  curve?: PerUtaCurve | null
  onClick: () => void
}) {
  const isDisabled = health?.disabled || uta.enabled === false
  const badge = preset
    ? { text: preset.badge, color: `${preset.badgeColor} ${preset.badgeColor.replace('text-', 'bg-')}/10` }
    : { text: uta.presetId.slice(0, 2).toUpperCase(), color: 'text-text-muted bg-text-muted/10' }

  // 24h delta for this UTA.
  const delta = curve && curve.latest != null && curve.firstAtCutoff != null
    ? { value: curve.latest - curve.firstAtCutoff, pct: curve.firstAtCutoff !== 0 ? ((curve.latest - curve.firstAtCutoff) / curve.firstAtCutoff) * 100 : 0 }
    : null

  const sparkValues = curve?.values ?? []
  const showSpark = !isDisabled && sparkValues.length >= 2

  const equityNum = equity ? Number(equity.equity) : null
  const cashNum = equity ? Number(equity.cash) : null

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border border-border bg-bg-secondary/30 px-4 py-3.5 transition-all hover:border-text-muted/40 hover:bg-bg-tertiary/20 ${isDisabled ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-3 mb-2.5">
        <span className={`text-[10px] font-bold px-2 py-1 rounded-md shrink-0 ${badge.color}`}>
          {badge.text}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text truncate">{uta.label || uta.id}</div>
          <div className="text-[11px] text-text-muted truncate mt-0.5 font-mono">
            {uta.id}
            <span className="mx-1.5 text-text-muted/40">·</span>
            {buildSubtitle(uta, preset)}
            {uta.guards.length > 0 && <span className="ml-1.5 text-text-muted/50">{uta.guards.length} guard{uta.guards.length > 1 ? 's' : ''}</span>}
          </div>
        </div>
        <div className="shrink-0">
          {uta.enabled === false
            ? <span className="text-[11px] text-text-muted">Disabled</span>
            : <HealthBadge health={health} />
          }
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          {equityNum != null && Number.isFinite(equityNum) ? (
            <p className="text-[22px] font-bold tabular-nums text-text leading-tight">
              {fmt(equityNum, 'USD')}
            </p>
          ) : (
            <p className="text-[16px] text-text-muted/70 italic">live data unavailable</p>
          )}
          {delta && (
            <p className={`text-[12px] tabular-nums mt-0.5 ${delta.value >= 0 ? 'text-green' : 'text-red'}`}>
              {delta.value >= 0 ? '▲' : '▼'} {fmtPnl(delta.value, 'USD')} ({fmtPctSigned(delta.pct)}) today
            </p>
          )}
          {cashNum != null && Number.isFinite(cashNum) && (
            <p className="text-[11px] text-text-muted mt-1">
              Cash <span className="text-text-muted tabular-nums">{fmt(cashNum, 'USD')}</span>
            </p>
          )}
        </div>
        {showSpark && (
          <div className="hidden md:block shrink-0">
            <Sparkline values={sparkValues} width={120} height={42} color="auto" />
          </div>
        )}
      </div>
    </button>
  )
}

// ==================== Hint renderer (markdown-lite) ====================

function HintBlock({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary/50 px-3 py-2.5 space-y-2">
      {text.trim().split('\n\n').map((para, i) => (
        <p key={i} className="text-[12px] text-text-muted leading-relaxed">
          {para.split(/(\*\*[^*]+\*\*)/).map((seg, j) =>
            seg.startsWith('**') && seg.endsWith('**')
              ? <strong key={j} className="text-text">{seg.slice(2, -2)}</strong>
              : <span key={j}>{seg}</span>
          )}
        </p>
      ))}
    </div>
  )
}

// ==================== Create Wizard (multi-step) ====================

function PickerSectionHeader({ title }: { title: string }) {
  return (
    <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide">
      {title}
    </p>
  )
}

type WizardStep = 'pick' | 'config' | 'test'

interface BrokerConflict {
  existing: { id: string; label: string; presetId: string }
}

function CreateWizard({ presets, onSave, onOpenExisting, onClose }: {
  presets: BrokerPreset[]
  onSave: (uta: Omit<UTAConfig, 'id'>) => Promise<UTAConfig>
  onOpenExisting: (id: string) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<WizardStep>('pick')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [showSecrets, setShowSecrets] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<BrokerConflict | null>(null)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  const preset = presets.find(p => p.id === presetId)
  const hasSensitive = preset?.schema && Object.values((preset.schema as { properties?: Record<string, { writeOnly?: boolean }> }).properties ?? {}).some(p => p.writeOnly)
  const { fields, formData, setField, getSubmitData, validate } = useSchemaForm(preset?.schema)

  const defaultName = preset?.defaultName ?? ''
  const finalName = name.trim() || defaultName

  const toOption = (p: BrokerPreset): SDKOption => ({
    id: p.id,
    name: p.label,
    description: p.description,
    badge: p.badge,
    badgeColor: p.badgeColor,
  })

  // 'testing' category presets (Simulator) are intentionally excluded — their
  // creation entry lives in Dev → Simulator so users picking a real broker
  // here don't see "Simulator" alongside Bybit / Alpaca / IBKR.
  const recommendedOptions: SDKOption[] = useMemo(
    () => presets.filter(p => p.category === 'recommended').map(toOption),
    [presets],
  )
  const cryptoOptions: SDKOption[] = useMemo(
    () => presets.filter(p => p.category === 'crypto').map(toOption),
    [presets],
  )

  const buildUTA = (): Omit<UTAConfig, 'id'> | null => {
    if (!preset) return null
    return {
      label: finalName,
      presetId: preset.id,
      enabled: true,
      guards: [],
      presetConfig: getSubmitData(),
    }
  }

  const handlePick = (id: string) => {
    setPresetId(id)
    setError('')
    setStep('config')
  }

  const handleTest = async () => {
    if (!preset) return
    setError('')
    setConflict(null)
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    const uta = buildUTA()
    if (!uta) return
    setTesting(true)
    try {
      const result = await api.trading.testConnection(uta)
      setTestResult(result)
      setStep('test')
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) })
      setStep('test')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    const uta = buildUTA()
    if (!uta) return
    setSaving(true); setError(''); setConflict(null)
    try {
      await onSave(uta)
    } catch (err) {
      // Surface 409 collision info (typed as BrokerAlreadyExistsError) so
      // the user can jump to the existing UTA instead of forking.
      if (err instanceof Error && err.name === 'BrokerAlreadyExistsError') {
        const existing = (err as Error & { existing?: BrokerConflict['existing'] }).existing
        if (existing) {
          setConflict({ existing })
          setSaving(false)
          return
        }
      }
      setError(err instanceof Error ? err.message : 'Failed to save UTA')
      setSaving(false)
    }
  }

  const headerLabel =
    step === 'pick'   ? 'New UTA · Pick Platform' :
    step === 'config' ? `New UTA · Configure ${preset?.label ?? ''}` :
                        `New UTA · Test ${preset?.label ?? ''}`

  return (
    <Dialog onClose={onClose}>
      <div className="shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-[14px] font-semibold text-text truncate">{headerLabel}</h3>
          <StepDots current={step} />
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text p-1 transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {step === 'pick' && (
          <div className="space-y-6">
            {recommendedOptions.length > 0 && (
              <section className="space-y-3">
                <PickerSectionHeader title="Recommended" />
                <SDKSelector options={recommendedOptions} selected={presetId ?? ''} onSelect={handlePick} />
              </section>
            )}
            {cryptoOptions.length > 0 && (
              <section className="space-y-3">
                <PickerSectionHeader title="Crypto" />
                <SDKSelector options={cryptoOptions} selected={presetId ?? ''} onSelect={handlePick} />
              </section>
            )}
          </div>
        )}

        {step === 'config' && preset && (
          <div className="space-y-5">
            {preset.hint && <HintBlock text={preset.hint} />}
            <div className="space-y-3">
              <Field label="Name" description="Display label for this account. The unique id is derived automatically from the credentials below.">
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} />
              </Field>
              <SchemaFormFields
                fields={fields}
                formData={formData}
                setField={setField}
                showSecrets={showSecrets}
              />
              {hasSensitive && (
                <button
                  onClick={() => setShowSecrets(!showSecrets)}
                  className="text-[11px] text-text-muted hover:text-text transition-colors"
                >
                  {showSecrets ? 'Hide secrets' : 'Show secrets'}
                </button>
              )}
              {error && <p className="text-[12px] text-red">{error}</p>}
            </div>
          </div>
        )}

        {step === 'test' && testResult && !conflict && (
          <TestResultPanel result={testResult} utaId={finalName} />
        )}

        {step === 'test' && conflict && (
          <BrokerConflictPanel existing={conflict.existing} onOpenExisting={() => onOpenExisting(conflict.existing.id)} />
        )}
      </div>

      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-t border-border">
        {step === 'pick' && (
          <>
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <span className="text-[11px] text-text-muted">Pick a platform to continue</span>
          </>
        )}
        {step === 'config' && (
          <>
            <button onClick={() => setStep('pick')} className="btn-secondary">← Back</button>
            <button onClick={handleTest} disabled={testing} className="btn-primary">
              {testing ? 'Testing...' : 'Test Connection →'}
            </button>
          </>
        )}
        {step === 'test' && (
          <>
            <button onClick={() => setStep('config')} className="btn-secondary">← Back</button>
            {conflict ? (
              <button onClick={() => onOpenExisting(conflict.existing.id)} className="btn-primary">
                Open existing
              </button>
            ) : testResult?.success ? (
              <button onClick={handleSave} disabled={saving} className="btn-primary">
                {saving ? 'Saving...' : 'Save UTA'}
              </button>
            ) : (
              <span className="text-[11px] text-text-muted">Fix the config and try again</span>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

// ==================== Wizard substeps ====================

function StepDots({ current }: { current: WizardStep }) {
  const order: WizardStep[] = ['pick', 'config', 'test']
  return (
    <div className="flex items-center gap-1.5">
      {order.map((s) => (
        <span
          key={s}
          className={`w-1.5 h-1.5 rounded-full transition-colors ${
            s === current ? 'bg-accent' : 'bg-border'
          }`}
        />
      ))}
    </div>
  )
}

function BrokerConflictPanel({ existing, onOpenExisting }: {
  existing: { id: string; label: string; presetId: string }
  onOpenExisting: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-yellow-400 shrink-0" />
        <span className="text-[13px] font-medium text-text">Broker already configured</span>
      </div>
      <div className="rounded-md border border-yellow-400/30 bg-yellow-400/5 px-3 py-2.5">
        <p className="text-[12px] text-text leading-relaxed">
          Another UTA already exists for this broker (same identity-defining credentials).
          Re-using the same key from a separate account would double-count its positions in
          aggregate views.
        </p>
        <p className="text-[12px] text-text-muted leading-relaxed mt-2">
          Existing: <strong className="text-text">{existing.label}</strong> <span className="font-mono text-text-muted/70">({existing.id})</span>
        </p>
      </div>
      <p className="text-[11px] text-text-muted">
        Click <strong className="text-text">Open existing</strong> to use it, or <strong className="text-text">← Back</strong> to point this UTA at a different account.
      </p>
      <button onClick={onOpenExisting} className="btn-secondary w-full">Open existing UTA</button>
    </div>
  )
}

function TestResultPanel({ result, utaId }: { result: TestConnectionResult; utaId: string }) {
  if (!result.success) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red shrink-0" />
          <span className="text-[13px] font-medium text-red">Connection failed</span>
        </div>
        <div className="rounded-md border border-red/30 bg-red/5 px-3 py-2.5">
          <p className="text-[12px] text-text leading-relaxed whitespace-pre-wrap">{result.error ?? 'Unknown error'}</p>
        </div>
        <p className="text-[11px] text-text-muted">
          Click <strong className="text-text">← Back</strong> to fix the configuration and try again.
        </p>
      </div>
    )
  }

  const acct: AccountInfo | undefined = result.account
  const positions: Position[] = result.positions ?? []
  const visiblePositions = positions.slice(0, 8)
  const moreCount = positions.length - visiblePositions.length

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-green shrink-0" />
        <span className="text-[13px] font-medium text-green">Connected as {utaId}</span>
      </div>

      {acct && (
        <div className="rounded-md border border-border bg-bg-secondary/50 px-3 py-2.5 space-y-1">
          <div className="flex justify-between text-[12px]">
            <span className="text-text-muted">Net Liquidation</span>
            <span className="text-text font-medium">{acct.baseCurrency} {acct.netLiquidation}</span>
          </div>
          <div className="flex justify-between text-[12px]">
            <span className="text-text-muted">Cash</span>
            <span className="text-text">{acct.baseCurrency} {acct.totalCashValue}</span>
          </div>
          {acct.unrealizedPnL !== '0' && (
            <div className="flex justify-between text-[12px]">
              <span className="text-text-muted">Unrealized P&L</span>
              <span className="text-text">{acct.baseCurrency} {acct.unrealizedPnL}</span>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="text-[12px] font-medium text-text-muted uppercase tracking-wide mb-2">
          Positions ({positions.length})
        </p>
        {positions.length === 0 ? (
          <p className="text-[12px] text-text-muted">No open positions — connection works, account is empty.</p>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-bg-tertiary/30 text-text-muted">
                  <th className="text-left px-2.5 py-1.5 font-medium">Contract</th>
                  <th className="text-left px-2.5 py-1.5 font-medium">Side</th>
                  <th className="text-right px-2.5 py-1.5 font-medium">Qty</th>
                  <th className="text-right px-2.5 py-1.5 font-medium">Mkt Value</th>
                </tr>
              </thead>
              <tbody>
                {visiblePositions.map((p, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2.5 py-1.5 text-text font-mono">{p.contract.aliceId ?? p.contract.localSymbol ?? p.contract.symbol ?? '?'}</td>
                    <td className="px-2.5 py-1.5 text-text-muted">{p.side}</td>
                    <td className="px-2.5 py-1.5 text-right text-text">{p.quantity}</td>
                    <td className="px-2.5 py-1.5 text-right text-text">{p.currency} {p.marketValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {moreCount > 0 && (
              <div className="px-2.5 py-1.5 border-t border-border text-[11px] text-text-muted bg-bg-tertiary/20">
                +{moreCount} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
