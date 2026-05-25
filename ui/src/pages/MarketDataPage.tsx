import { useEffect, useMemo, useState } from 'react'
import { api, type AppConfig } from '../api'
import type { MarketDataAlertItem, MarketDataAlertRun, MarketDataAlertsResponse, MarketDataWatchResponse } from '../api/openbb'
import type {
  SignalEngineConfig,
  SignalEngineConfigItem,
  SignalEngineRiskTemplateRecord,
  SignalEngineRun,
  SignalEngineSignal,
  SignalEngineStrategyRecord,
} from '../api/signals'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Field, inputClass } from '../components/form'
import { Toggle } from '../components/Toggle'
import { useConfigPage } from '../hooks/useConfigPage'
import { PageHeader } from '../components/PageHeader'

type MarketDataConfig = Record<string, unknown>

// ==================== Constants ====================

const ASSET_LABELS: Record<string, string> = {
  equity: 'Equity',
  crypto: 'Crypto',
  currency: 'Currency',
  commodity: 'Commodity',
}

// ==================== Test Button ====================

function TestButton({
  status,
  disabled,
  onClick,
}: {
  status: 'idle' | 'testing' | 'ok' | 'error'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 border rounded-md px-3 py-2 text-[13px] font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default ${
        status === 'ok'
          ? 'border-green text-green'
          : status === 'error'
            ? 'border-red text-red'
            : 'border-border text-text-muted hover:bg-bg-tertiary hover:text-text'
      }`}
    >
      {status === 'testing' ? '...' : status === 'ok' ? 'OK' : status === 'error' ? 'Fail' : 'Test'}
    </button>
  )
}

// ==================== Page ====================

export function MarketDataPage() {
  const { config, status, loadError, updateConfig, updateConfigImmediate, retry } = useConfigPage<MarketDataConfig>({
    section: 'marketData',
    extract: (full: AppConfig) => (full as Record<string, unknown>).marketData as MarketDataConfig,
  })

  const enabled = !config || (config as Record<string, unknown>).enabled !== false

  if (!config) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <PageHeader title="Market Data" description="Structured financial data — prices, fundamentals, macro indicators." />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[13px] text-text-muted">Loading...</p>
        </div>
      </div>
    )
  }

  const dataBackend = (config.backend as string) || 'typebb-sdk'
  const apiUrl = (config.apiUrl as string) || 'http://localhost:6900'
  const providers = (config.providers ?? { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' }) as Record<string, string>
  const providerKeys = (config.providerKeys ?? {}) as Record<string, string>
  const knownAssets = Object.keys(ASSET_LABELS)
  const providerSuggestions = (() => {
    const collected = new Set<string>()
    for (const value of Object.values(providers)) {
      if (value?.trim()) collected.add(value.trim())
    }
    for (const key of Object.keys(providerKeys)) {
      if (key?.trim()) collected.add(key.trim())
    }
    return Array.from(collected).sort((a, b) => a.localeCompare(b))
  })()

  const handleProviderChange = (asset: string, provider: string) => {
    updateConfigImmediate({ providers: { ...providers, [asset]: provider } })
  }

  const handleKeyChange = (keyName: string, value: string) => {
    const all = (config.providerKeys ?? {}) as Record<string, string>
    const updated = { ...all, [keyName]: value }
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(updated)) {
      if (v) cleaned[k] = v
    }
    updateConfig({ providerKeys: cleaned })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title="Market Data"
        description="Structured financial data — prices, fundamentals, macro indicators."
        right={
          <div className="flex items-center gap-3">
            <SaveIndicator status={status} onRetry={retry} />
            <Toggle size="sm" checked={enabled} onChange={(v) => updateConfigImmediate({ enabled: v })} />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5">
        <div className={`max-w-[880px] mx-auto ${!enabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <MarketDataOperations />

          {/* Asset Providers — route selection only, no keys */}
          <AssetProvidersSection
            providers={providers}
            assets={knownAssets}
            suggestions={providerSuggestions}
            onProviderChange={handleProviderChange}
          />

          {/* API Keys — unified credential management */}
          <ApiKeysSection
            providers={providers}
            providerKeys={providerKeys}
            suggestions={providerSuggestions}
            onKeyChange={handleKeyChange}
          />

          {/* Advanced — backend switch */}
          <AdvancedSection
            backend={dataBackend}
            apiUrl={apiUrl}
            onBackendChange={(backend) => updateConfigImmediate({ backend })}
            onApiUrlChange={(url) => updateConfig({ apiUrl: url })}
          />
        </div>
        {loadError && <p className="text-[13px] text-red mt-4 max-w-[880px] mx-auto">Failed to load configuration.</p>}
      </div>
    </div>
  )
}

// ==================== Operations ====================

function MarketDataOperations() {
  const [watch, setWatch] = useState<MarketDataWatchResponse | null>(null)
  const [alerts, setAlerts] = useState<MarketDataAlertsResponse | null>(null)
  const [runs, setRuns] = useState<MarketDataAlertRun[]>([])
  const [signalRuns, setSignalRuns] = useState<SignalEngineRun[]>([])
  const [signalConfig, setSignalConfig] = useState<SignalEngineConfig | null>(null)
  const [strategies, setStrategies] = useState<SignalEngineStrategyRecord[]>([])
  const [riskTemplates, setRiskTemplates] = useState<SignalEngineRiskTemplateRecord[]>([])
  const [signalError, setSignalError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [setupForms, setSetupForms] = useState<Record<string, Partial<SetupFormState>>>({})

  const load = async () => {
    setError(null)
    setSignalError(null)
    try {
      const [watchRes, alertsRes, runsRes, signalRunsRes] = await Promise.all([
        api.marketData.watch(),
        api.marketData.alerts(),
        api.marketData.alertRuns({ limit: 20 }),
        api.signals.runs({ limit: 12 }).catch((err) => {
          setSignalError(err instanceof Error ? err.message : String(err))
          return null
        }),
      ])
      const [signalConfigRes, strategiesRes, riskTemplatesRes] = await Promise.all([
        api.signals.config().catch((err) => {
          setSignalError(err instanceof Error ? err.message : String(err))
          return null
        }),
        api.signals.strategies().catch(() => ({ entries: [] })),
        api.signals.riskTemplates().catch(() => ({ entries: [] })),
      ])
      setWatch(watchRes)
      setAlerts(alertsRes)
      setRuns(runsRes.entries)
      setSignalRuns(signalRunsRes?.entries ?? [])
      setSignalConfig(signalConfigRes)
      setStrategies(strategiesRes.entries)
      setRiskTemplates(riskTemplatesRes.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const runNow = async (kind: 'watch' | 'alerts') => {
    setAction(kind)
    setError(null)
    try {
      if (kind === 'watch') await api.marketData.runWatch()
      else await api.marketData.runAlerts()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAction(null)
    }
  }

  const recordFeedback = async (runId: string, rating: string) => {
    setAction(`feedback:${runId}`)
    setError(null)
    try {
      await api.marketData.recordAlertFeedback(runId, rating, notes[runId])
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAction(null)
    }
  }

  const saveSignalConfig = async (next: SignalEngineConfig) => {
    setAction('signal-config')
    setError(null)
    try {
      const saved = await api.signals.saveConfig(next)
      setSignalConfig(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAction(null)
    }
  }

  const updateAlertPreset = async (run: MarketDataAlertRun, preset: AlertOptionPreset) => {
    const item = findAlertItem(alerts?.items ?? [], run)
    if (!item || !run.asset || !run.symbol || !run.interval) return
    setAction(`tune:${run.runId}`)
    setError(null)
    try {
      await api.marketData.upsertAlert({
        asset: run.asset,
        symbol: run.symbol,
        interval: run.interval,
        provider: run.provider ?? item.provider,
        enabled: item.enabled,
        mode: item.mode,
        lookbackBars: item.lookbackBars,
        cooldownMinutes: item.cooldownMinutes,
        maxSignalAgeBars: numberSetting(preset.thresholds?.maxSignalAgeBars ?? item.thresholds?.maxSignalAgeBars),
        minVolumeScore: numberSetting(preset.thresholds?.minVolumeScore ?? item.thresholds?.minVolumeScore),
        options: { ...(item.options ?? {}), ...preset.options },
        ensureWatch: true,
        enableAlerts: true,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAction(null)
    }
  }

  const createSetup = async (run: MarketDataAlertRun) => {
    const form = setupForms[run.runId] ?? {}
    setAction(`setup:${run.runId}`)
    setError(null)
    try {
      const result = await api.trading.createTradeSetup({
        alertRunId: run.runId,
        source: form.source ?? '',
        aliceId: form.aliceId ?? '',
        action: form.action,
        orderType: form.orderType,
        totalQuantity: form.totalQuantity,
        cashQty: form.cashQty,
        lmtPrice: form.lmtPrice,
        takeProfitPrice: form.takeProfitPrice,
        stopLossPrice: form.stopLossPrice,
        thesis: form.thesis || run.summary,
        invalidation: form.invalidation ?? '',
        riskNotes: form.riskNotes,
      })
      if (!result.ok) throw new Error(result.error ?? 'Create setup failed')
      setSetupForms((prev) => ({ ...prev, [run.runId]: { ...form, createdSetupId: result.setup?.setupId } }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAction(null)
    }
  }

  return (
    <ConfigSection
      title="Operations"
      description="Observe OHLCV cache health, technical-analysis alerts, and alert quality feedback."
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <button className={buttonClass} onClick={() => void load()} disabled={loading || action !== null}>
            {loading ? 'Loading' : 'Refresh'}
          </button>
          <button className={buttonClass} onClick={() => void runNow('watch')} disabled={action !== null}>
            {action === 'watch' ? 'Running' : 'Run Watch'}
          </button>
          <button className={buttonClass} onClick={() => void runNow('alerts')} disabled={action !== null}>
            {action === 'alerts' ? 'Running' : 'Run Alerts'}
          </button>
          {error && <span className="text-[12px] text-red">{error}</span>}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <WatchPanel watch={watch} />
          <AlertsPanel alerts={alerts} />
        </div>

        <AlertRunsPanel
          runs={runs}
          alertItems={alerts?.items ?? []}
          notes={notes}
          action={action}
          onNote={(runId, note) => setNotes((prev) => ({ ...prev, [runId]: note }))}
          onFeedback={recordFeedback}
          onTune={updateAlertPreset}
          setupForms={setupForms}
          onSetupForm={(runId, patch) => setSetupForms((prev) => ({ ...prev, [runId]: { ...prev[runId], ...patch } }))}
          onCreateSetup={createSetup}
        />

        <SignalEngineConfigPanel
          config={signalConfig}
          strategies={strategies}
          riskTemplates={riskTemplates}
          saving={action === 'signal-config'}
          onSave={saveSignalConfig}
        />

        <SignalEngineRunsPanel runs={signalRuns} error={signalError} onRefresh={load} />
      </div>
    </ConfigSection>
  )
}

const buttonClass = 'px-2.5 py-1.5 text-[12px] border border-border rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-default'

interface AlertOptionPreset {
  id: string
  label: string
  description: string
  options: Record<string, unknown>
  thresholds?: Record<string, number>
}

const ALERT_OPTION_PRESETS: AlertOptionPreset[] = [
  {
    id: 'trend-filter',
    label: 'Trend filter',
    description: 'Prefer close-confirmed structure and longer EMA context.',
    options: { useCloseBreak: true, emaFastPeriod: 21, emaSlowPeriod: 55, emaLongPeriod: 200 },
    thresholds: { maxSignalAgeBars: 3 },
  },
  {
    id: 'liquidity-ifvg',
    label: 'Liquidity / IFVG',
    description: 'Emphasize liquidity zones, stop runs, and inverse FVG context.',
    options: { fvgMode: 'IFVG', liquidity: { enabled: true, minClusterSize: 3, maxVisible: 25 }, stopZone: { enabled: true, maxActive: 20 } },
    thresholds: { maxSignalAgeBars: 4 },
  },
  {
    id: 'volume-profile',
    label: 'Volume profile',
    description: 'Enable volume profile and unusual-volume confirmation.',
    options: { volumeProfile: { enabled: true, mode: 'rolling', lookback: 300, bins: 80 }, unusualVolume: { enabled: true, zScoreThreshold: 2, rvolThreshold: 1.8 } },
    thresholds: { minVolumeScore: 0.6 },
  },
  {
    id: 'strict-confluence',
    label: 'Strict confluence',
    description: 'Require stronger confluence and tighter recent-signal age.',
    options: { confluenceZone: { enabled: true, minFamilies: 3, overlapAtrMultiplier: 0.6 }, zoneFilter: { enabled: true, mergeOverlappingZones: true, maxDistanceAtr: 3 } },
    thresholds: { maxSignalAgeBars: 2, minVolumeScore: 0.7 },
  },
]

interface SetupFormState {
  source: string
  aliceId: string
  action: 'BUY' | 'SELL'
  orderType: 'MKT' | 'LMT'
  totalQuantity: string
  cashQty: string
  lmtPrice: string
  takeProfitPrice: string
  stopLossPrice: string
  thesis: string
  invalidation: string
  riskNotes: string
  createdSetupId: string
}

function WatchPanel({ watch }: { watch: MarketDataWatchResponse | null }) {
  return (
    <div className="border border-border/60 rounded-lg bg-bg-secondary/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[13px] font-semibold text-text">Watch & Cache</h4>
        <StatusPill active={watch?.enabled ?? false} text={watch?.enabled ? `every ${watch.every}` : 'off'} />
      </div>
      {!watch || watch.items.length === 0 ? (
        <p className="text-[12px] text-text-muted/60">No watched OHLCV items.</p>
      ) : (
        <div className="space-y-2">
          {watch.items.slice(0, 6).map((item) => (
            <div key={`${item.asset}:${item.symbol}:${item.provider}`} className="text-[12px] border border-border/40 rounded-md px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-text">{item.symbol}</span>
                <span className="text-text-muted">{item.asset}</span>
                <span className="text-text-muted">{item.provider}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {item.cache.map((cache) => (
                  <span key={cache.interval} className={`px-1.5 py-0.5 rounded text-[11px] ${cache.healthy ? 'bg-green/10 text-green' : 'bg-red/10 text-red'}`}>
                    {cache.interval}: {cache.bars} bars{cache.updatedAt ? `, ${shortDate(cache.updatedAt)}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AlertsPanel({ alerts }: { alerts: MarketDataAlertsResponse | null }) {
  return (
    <div className="border border-border/60 rounded-lg bg-bg-secondary/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[13px] font-semibold text-text">Alerts</h4>
        <StatusPill active={alerts?.enabled ?? false} text={alerts?.enabled ? `${alerts.mode}, ${alerts.every}` : 'off'} />
      </div>
      {!alerts || alerts.items.length === 0 ? (
        <p className="text-[12px] text-text-muted/60">No technical-analysis alerts configured.</p>
      ) : (
        <div className="space-y-2">
          {alerts.items.slice(0, 6).map((item) => (
            <div key={`${item.asset}:${item.symbol}:${item.interval}:${item.provider ?? ''}`} className="text-[12px] border border-border/40 rounded-md px-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-text">{item.symbol}</span>
                <span className="text-text-muted">{item.interval}</span>
                <span className="text-text-muted">{item.mode}</span>
                <StatusPill active={item.enabled} text={item.enabled ? 'on' : 'off'} />
              </div>
              <p className="mt-1 text-text-muted/70">
                cooldown {item.cooldownMinutes}m, lookback {item.lookbackBars}, thresholds {formatThresholds(item.thresholds)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AlertRunsPanel({
  runs,
  alertItems,
  notes,
  action,
  onNote,
  onFeedback,
  onTune,
  setupForms,
  onSetupForm,
  onCreateSetup,
}: {
  runs: MarketDataAlertRun[]
  alertItems: MarketDataAlertItem[]
  notes: Record<string, string>
  action: string | null
  onNote: (runId: string, note: string) => void
  onFeedback: (runId: string, rating: string) => void
  onTune: (run: MarketDataAlertRun, preset: AlertOptionPreset) => void
  setupForms: Record<string, Partial<SetupFormState>>
  onSetupForm: (runId: string, patch: Partial<SetupFormState>) => void
  onCreateSetup: (run: MarketDataAlertRun) => void
}) {
  return (
    <div className="border border-border/60 rounded-lg bg-bg-secondary/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[13px] font-semibold text-text">Recent Alert Runs</h4>
        <span className="text-[11px] text-text-muted">{runs.length} shown</span>
      </div>
      {runs.length === 0 ? (
        <p className="text-[12px] text-text-muted/60">No alert run history yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => {
            const item = findAlertItem(alertItems, run)
            return (
            <details key={run.runId} className="border border-border/40 rounded-md px-2.5 py-2 text-[12px]">
              <summary className="cursor-pointer list-none">
              <div className="flex flex-wrap items-center gap-2">
                <StatusText status={run.status} />
                <span className="font-mono text-text">{run.symbol ?? 'system'}</span>
                {run.interval && <span className="text-text-muted">{run.interval}</span>}
                <span className="text-text-muted">{shortDate(run.startedAt)}</span>
                {run.feedback && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">{run.feedback.rating}</span>}
              </div>
              <p className="mt-1 text-text-muted/80">{run.summary}</p>
              </summary>
              {run.signals.length > 0 && (
                <div className="mt-2 space-y-1">
                  {run.signals.slice(0, 5).map((signal) => (
                    <div key={signal.id} className="rounded bg-bg-tertiary/60 px-2 py-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-text">{signal.label}</span>
                        <span className="text-text-muted">{signal.kind}</span>
                        {signal.direction && <span className="text-accent">{signal.direction}</span>}
                        {typeof signal.score === 'number' && <span className="text-text-muted">score {signal.score.toFixed(2)}</span>}
                      </div>
                      <p className="text-text-muted/70">{signal.message}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="rounded border border-border/40 px-2 py-2">
                  <div className="text-[11px] uppercase text-text-muted/60">Technical Analysis</div>
                  <p className="mt-1 text-text-muted/80">
                    top signals {run.signals.length}, latest close {run.latestClose ?? 'n/a'}, mode {run.mode ?? item?.mode ?? 'n/a'}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {qualityHints(run, item).map((hint) => (
                      <span key={hint} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-muted">{hint}</span>
                    ))}
                  </div>
                </div>
                <div className="rounded border border-border/40 px-2 py-2">
                  <div className="text-[11px] uppercase text-text-muted/60">Tuning Presets</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {ALERT_OPTION_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        className={buttonClass}
                        disabled={action !== null || !item}
                        title={preset.description}
                        onClick={() => onTune(run, preset)}
                      >
                        {action === `tune:${run.runId}` ? 'Saving' : preset.label}
                      </button>
                    ))}
                  </div>
                  {run.feedback?.rating === 'needs_tuning' && (
                    <p className="mt-1 text-[11px] text-accent">Feedback points to stricter confluence or volume/liquidity filters.</p>
                  )}
                  {item && <p className="mt-1 text-[11px] text-text-muted/60">Current thresholds: {formatThresholds(item.thresholds)}</p>}
                </div>
              </div>
              {run.feedback?.note && <p className="mt-2 text-[11px] text-text-muted/70">Feedback: {run.feedback.note}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input
                  className="min-w-[180px] flex-1 px-2 py-1 bg-bg text-text border border-border rounded-md text-[12px] outline-none focus:border-accent"
                  value={notes[run.runId] ?? ''}
                  onChange={(e) => onNote(run.runId, e.target.value)}
                  placeholder="Feedback note"
                />
                {(['useful', 'false_positive', 'ignored', 'needs_tuning'] as const).map((rating) => (
                  <button
                    key={rating}
                    className={buttonClass}
                    disabled={action !== null}
                    onClick={() => onFeedback(run.runId, rating)}
                  >
                    {action === `feedback:${run.runId}` ? 'Saving' : rating}
                  </button>
                ))}
              </div>
              {run.status === 'triggered' && (
                <SetupMiniForm
                  run={run}
                  form={setupForms[run.runId] ?? {}}
                  saving={action === `setup:${run.runId}`}
                  onPatch={(patch) => onSetupForm(run.runId, patch)}
                  onCreate={() => onCreateSetup(run)}
                />
              )}
            </details>
          )})}
        </div>
      )}
    </div>
  )
}

interface ReplayComparison {
  replayRunId: string
  inputSame: boolean
  outputSame: boolean
  signalsSame: boolean | null
}

function SignalEngineRunsPanel({ runs, error, onRefresh }: { runs: SignalEngineRun[]; error: string | null; onRefresh: () => Promise<void> }) {
  const [replaying, setReplaying] = useState<string | null>(null)
  const [comparisons, setComparisons] = useState<Record<string, ReplayComparison>>({})
  const [localError, setLocalError] = useState<string | null>(null)

  const replay = async (run: SignalEngineRun) => {
    setReplaying(run.runId)
    setLocalError(null)
    try {
      const replayRun = await api.signals.replay(run.runId, { startedAt: new Date().toISOString() })
      let signalsSame: boolean | null = null
      try {
        const artifact = await api.signals.artifact(replayRun.runId)
        signalsSame = compareSignalHashes(run.signals, signalHashesFromOutput(artifact.output))
      } catch {
        signalsSame = null
      }
      setComparisons((prev) => ({
        ...prev,
        [run.runId]: {
          replayRunId: replayRun.runId,
          inputSame: Boolean(run.inputHash && replayRun.inputHash && run.inputHash === replayRun.inputHash),
          outputSame: Boolean(run.outputHash && replayRun.outputHash && run.outputHash === replayRun.outputHash),
          signalsSame,
        },
      }))
      await onRefresh()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setReplaying(null)
    }
  }

  return (
    <div className="border border-border/60 rounded-lg bg-bg-secondary/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[13px] font-semibold text-text">Signal Engine Runs</h4>
        <span className="text-[11px] text-text-muted">{runs.length} shown</span>
      </div>
      {error && <p className="mb-2 text-[12px] text-red">Signal Engine unavailable: {error}</p>}
      {localError && <p className="mb-2 text-[12px] text-red">{localError}</p>}
      {!error && runs.length === 0 ? (
        <p className="text-[12px] text-text-muted/60">No signal-engine run history yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <details key={run.runId} className="border border-border/40 rounded-md px-2.5 py-2 text-[12px]">
              <summary className="cursor-pointer list-none">
              <div className="flex flex-wrap items-center gap-2">
                <StatusText status={run.status as MarketDataAlertRun['status']} />
                <span className="font-mono text-text">{run.symbol ?? provenanceText(run.provenance, 'symbol') ?? 'system'}</span>
                {(run.interval || provenanceText(run.provenance, 'interval')) && (
                  <span className="text-text-muted">{run.interval ?? provenanceText(run.provenance, 'interval')}</span>
                )}
                {(run.provider || provenanceText(run.provenance, 'provider')) && (
                  <span className="text-text-muted">{run.provider ?? provenanceText(run.provenance, 'provider')}</span>
                )}
                {run.startedAt && <span className="text-text-muted">{shortDate(run.startedAt)}</span>}
                {hashValue(run) && <HashChip label="run" value={hashValue(run)!} />}
                <AutoStagePill run={run} />
              </div>
              {run.summary && <p className="mt-1 text-text-muted/80">{run.summary}</p>}
              </summary>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="rounded border border-border/40 px-2 py-2">
                  <div className="text-[11px] uppercase text-text-muted/60">Strategy</div>
                  <p className="mt-1 font-mono text-text">
                    {run.strategyId ?? 'unknown'}@{run.strategyVersion ?? '?'}
                  </p>
                  <p className="text-text-muted/70">
                    risk {run.riskTemplateId ?? provenanceText(run.provenance, 'riskTemplateId') ?? 'unknown'}@{run.riskTemplateVersion ?? provenanceText(run.provenance, 'riskTemplateVersion') ?? '?'}
                  </p>
                </div>
                <div className="rounded border border-border/40 px-2 py-2">
                  <div className="text-[11px] uppercase text-text-muted/60">Replay</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <button className={buttonClass} disabled={replaying !== null} onClick={() => replay(run)}>
                      {replaying === run.runId ? 'Replaying' : 'Replay'}
                    </button>
                    {run.replayOfRunId && <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-text-muted">of {shortHash(run.replayOfRunId)}</span>}
                  </div>
                  {comparisons[run.runId] && <ReplayResult value={comparisons[run.runId]} />}
                </div>
              </div>
              <SignalHashList signals={run.signals} />
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-text-muted/70">
                {run.inputHash && <HashChip label="input" value={run.inputHash} />}
                {run.outputHash && <HashChip label="output" value={run.outputHash} />}
                {provenanceChips(run).map((chip) => (
                  <span key={chip} className="rounded bg-bg-tertiary px-1.5 py-0.5">{chip}</span>
                ))}
                <AutoStageLinks run={run} />
              </div>
              {run.error && <p className="mt-1 text-red/80">{run.error}</p>}
              <p className="mt-2 text-[11px] text-text-muted/60">Staged setups are reviewed and pushed manually from Trading.</p>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

function ReplayResult({ value }: { value: ReplayComparison }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-muted">replay {shortHash(value.replayRunId)}</span>
      <MatchPill label="input" ok={value.inputSame} />
      <MatchPill label="output" ok={value.outputSame} />
      <MatchPill label="signals" ok={value.signalsSame} />
    </div>
  )
}

function MatchPill({ label, ok }: { label: string; ok: boolean | null }) {
  const cls = ok === true ? 'bg-green/10 text-green' : ok === false ? 'bg-red/10 text-red' : 'bg-bg-tertiary text-text-muted'
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{label} {ok == null ? 'n/a' : ok ? 'same' : 'diff'}</span>
}

function SignalHashList({ signals }: { signals: SignalEngineSignal[] }) {
  if (signals.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {signals.slice(0, 6).map((signal, index) => (
        <span key={signal.id ?? index} className="rounded border border-border/50 px-1.5 py-0.5 text-[11px] text-text-muted">
          {signal.label ?? signal.kind ?? signal.direction ?? 'signal'}
          {hashValue(signal) ? <span className="ml-1 font-mono text-accent">{shortHash(hashValue(signal)!)}</span> : null}
        </span>
      ))}
    </div>
  )
}

function SignalEngineConfigPanel({
  config,
  strategies,
  riskTemplates,
  saving,
  onSave,
}: {
  config: SignalEngineConfig | null
  strategies: SignalEngineStrategyRecord[]
  riskTemplates: SignalEngineRiskTemplateRecord[]
  saving: boolean
  onSave: (config: SignalEngineConfig) => void
}) {
  const [draft, setDraft] = useState<SignalEngineConfig | null>(config)

  useEffect(() => {
    setDraft(config)
  }, [config])

  const patch = (change: Partial<SignalEngineConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...change } : prev))
  }

  const patchAutoStage = (change: Partial<SignalEngineConfig['autoStage']>) => {
    setDraft((prev) => prev ? {
      ...prev,
      autoStage: { ...prev.autoStage, ...change, neverPush: true },
    } : prev)
  }

  const patchItem = (index: number, change: Partial<SignalEngineConfigItem>) => {
    setDraft((prev) => prev ? {
      ...prev,
      items: prev.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...change } : item),
    } : prev)
  }

  if (!draft) {
    return (
      <div className="border border-border/60 rounded-lg bg-bg-secondary/20 p-3">
        <h4 className="text-[13px] font-semibold text-text">Signal Engine Config</h4>
        <p className="mt-1 text-[12px] text-text-muted/60">Signal engine config unavailable.</p>
      </div>
    )
  }

  return (
    <div className="border border-border/60 rounded-lg bg-bg-secondary/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-[13px] font-semibold text-text">Signal Engine Config</h4>
        <button className={buttonClass} disabled={saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving' : 'Save Config'}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[12px]">
        <label className="text-text-muted">
          Enabled
          <select className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md" value={String(draft.enabled)} onChange={(e) => patch({ enabled: e.target.value === 'true' })}>
            <option value="true">on</option>
            <option value="false">off</option>
          </select>
        </label>
        <SetupInput label="Every" value={draft.every} onChange={(every) => patch({ every })} />
        <label className="text-text-muted">
          Auto-stage
          <select className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md" value={String(draft.autoStage.enabled)} onChange={(e) => patchAutoStage({ enabled: e.target.value === 'true' })}>
            <option value="false">off</option>
            <option value="true">stage only</option>
          </select>
        </label>
        <SetupInput label="Default UTA" value={draft.autoStage.defaultUtaId ?? ''} onChange={(defaultUtaId) => patchAutoStage({ defaultUtaId: defaultUtaId || undefined })} placeholder="simulator/paper UTA" />
      </div>
      <p className="mt-2 text-[11px] text-text-muted/70">Auto-stage is limited to simulator/paper semantics and never pushes broker orders.</p>
      <div className="mt-3 space-y-2">
        {draft.items.length === 0 ? (
          <p className="text-[12px] text-text-muted/60">No configured signal-engine items.</p>
        ) : draft.items.map((item, index) => (
          <div key={`${item.asset}:${item.symbol}:${item.interval}:${index}`} className="rounded border border-border/40 px-2 py-2">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-2 text-[12px]">
              <label className="text-text-muted">
                On
                <select className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md" value={String(item.enabled !== false)} onChange={(e) => patchItem(index, { enabled: e.target.value === 'true' })}>
                  <option value="true">on</option>
                  <option value="false">off</option>
                </select>
              </label>
              <SetupInput label="Asset" value={item.asset} onChange={(asset) => patchItem(index, { asset })} />
              <SetupInput label="Symbol" value={item.symbol} onChange={(symbol) => patchItem(index, { symbol })} />
              <SetupInput label="Interval" value={item.interval} onChange={(interval) => patchItem(index, { interval })} />
              <SetupInput label="Provider" value={item.provider ?? ''} onChange={(provider) => patchItem(index, { provider: provider || undefined })} />
              <SetupInput label="Lookback" value={String(item.lookbackBars)} onChange={(lookbackBars) => patchItem(index, { lookbackBars: Math.max(1, Number(lookbackBars) || item.lookbackBars) })} />
            </div>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-[12px]">
              <CatalogSelect
                label="Strategy"
                value={`${item.strategyId}@${item.strategyVersion}`}
                options={strategies.map((strategy) => ({ value: `${strategy.id}@${strategy.version}`, label: `${strategy.id}@${strategy.version}` }))}
                onChange={(value) => {
                  const [strategyId, strategyVersion] = splitVersioned(value)
                  patchItem(index, { strategyId, strategyVersion })
                }}
              />
              <CatalogSelect
                label="Risk Template"
                value={`${item.riskTemplateId}@${item.riskTemplateVersion}`}
                options={riskTemplates.map((risk) => ({ value: `${risk.id}@${risk.version}`, label: `${risk.id}@${risk.version}` }))}
                onChange={(value) => {
                  const [riskTemplateId, riskTemplateVersion] = splitVersioned(value)
                  patchItem(index, { riskTemplateId, riskTemplateVersion })
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CatalogSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <label className="text-text-muted">
      {label}
      <select className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={value}>{value}</option>
        {options.filter((option) => option.value !== value).map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

function SetupMiniForm({
  run,
  form,
  saving,
  onPatch,
  onCreate,
}: {
  run: MarketDataAlertRun
  form: Partial<SetupFormState>
  saving: boolean
  onPatch: (patch: Partial<SetupFormState>) => void
  onCreate: () => void
}) {
  const disabled = Boolean(form.createdSetupId)
  return (
    <details className="mt-2 rounded-md border border-border/40 bg-bg-secondary/20 px-2 py-2">
      <summary className="cursor-pointer text-[12px] text-text-muted hover:text-text">
        {form.createdSetupId ? `Setup created: ${form.createdSetupId.slice(0, 8)}` : 'Create trade setup'}
      </summary>
      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
        <SetupInput label="UTA" value={form.source ?? ''} disabled={disabled} onChange={(source) => onPatch({ source })} placeholder="alpaca-main" />
        <SetupInput label="aliceId" value={form.aliceId ?? ''} disabled={disabled} onChange={(aliceId) => onPatch({ aliceId })} placeholder={`${form.source || 'account'}|${run.symbol ?? 'SYMBOL'}`} />
        <label className="text-[11px] text-text-muted">
          Action
          <select
            className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md outline-none focus:border-accent"
            value={form.action ?? defaultAction(run)}
            disabled={disabled}
            onChange={(e) => onPatch({ action: e.target.value as 'BUY' | 'SELL' })}
          >
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </label>
        <label className="text-[11px] text-text-muted">
          Order
          <select
            className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md outline-none focus:border-accent"
            value={form.orderType ?? 'MKT'}
            disabled={disabled}
            onChange={(e) => onPatch({ orderType: e.target.value as 'MKT' | 'LMT' })}
          >
            <option value="MKT">MKT</option>
            <option value="LMT">LMT</option>
          </select>
        </label>
        <SetupInput label="Qty" value={form.totalQuantity ?? ''} disabled={disabled} onChange={(totalQuantity) => onPatch({ totalQuantity, cashQty: '' })} placeholder="1" />
        <SetupInput label="Cash Qty" value={form.cashQty ?? ''} disabled={disabled} onChange={(cashQty) => onPatch({ cashQty, totalQuantity: '' })} placeholder="500" />
        <SetupInput label="Limit" value={form.lmtPrice ?? ''} disabled={disabled} onChange={(lmtPrice) => onPatch({ lmtPrice })} placeholder="optional" />
        <SetupInput label="Stop Loss" value={form.stopLossPrice ?? ''} disabled={disabled} onChange={(stopLossPrice) => onPatch({ stopLossPrice })} placeholder="required before staging" />
        <SetupInput label="Take Profit" value={form.takeProfitPrice ?? ''} disabled={disabled} onChange={(takeProfitPrice) => onPatch({ takeProfitPrice })} placeholder="optional" />
        <SetupInput label="Invalidation" value={form.invalidation ?? ''} disabled={disabled} onChange={(invalidation) => onPatch({ invalidation })} placeholder="below OB / above sweep high" />
      </div>
      <textarea
        className="mt-2 w-full px-2 py-1 bg-bg text-text border border-border rounded-md text-[12px] outline-none focus:border-accent resize-y"
        rows={2}
        value={form.riskNotes ?? ''}
        disabled={disabled}
        onChange={(e) => onPatch({ riskNotes: e.target.value })}
        placeholder="Risk notes"
      />
      <div className="mt-2 flex items-center gap-2">
        <button className={buttonClass} disabled={saving || disabled} onClick={onCreate}>
          {saving ? 'Creating' : 'Save Setup'}
        </button>
        <span className="text-[11px] text-text-muted">Saving a setup does not stage or execute it.</span>
      </div>
    </details>
  )
}

function SetupInput({
  label,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  disabled?: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="text-[11px] text-text-muted">
      {label}
      <input
        className="mt-1 w-full px-2 py-1 bg-bg text-text border border-border rounded-md outline-none focus:border-accent disabled:opacity-60"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function defaultAction(run: MarketDataAlertRun): 'BUY' | 'SELL' {
  const bearish = run.signals.some((signal) => String((signal as { direction?: unknown }).direction) === 'bearish')
  return bearish ? 'SELL' : 'BUY'
}

function StatusPill({ active, text }: { active: boolean; text: string }) {
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded ${active ? 'bg-green/10 text-green' : 'bg-bg-tertiary text-text-muted'}`}>
      {text}
    </span>
  )
}

function StatusText({ status }: { status: MarketDataAlertRun['status'] }) {
  const cls = status === 'triggered' ? 'text-green' : status === 'error' ? 'text-red' : 'text-text-muted'
  return <span className={`font-mono ${cls}`}>{status}</span>
}

function AutoStagePill({ run }: { run: SignalEngineRun }) {
  const status = String(run.autoStageStatus ?? autoStageResult(run)?.status ?? (run.autoStage ? 'enabled' : 'disabled'))
  const active = status === 'staged' || status === 'draft_created' || status === 'enabled'
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded ${active ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted'}`}>
      auto-stage {status}
    </span>
  )
}

function AutoStageLinks({ run }: { run: SignalEngineRun }) {
  const entries = autoStageResult(run)?.entries ?? []
  const setupIds = [
    run.stagedSetupId,
    run.setupId,
    ...entries.map((entry) => entry.setupId),
  ].filter((value): value is string => Boolean(value))
  if (setupIds.length === 0) return null
  return (
    <>
      {[...new Set(setupIds)].map((setupId) => (
        <a key={setupId} className="rounded bg-accent/10 px-1.5 py-0.5 text-accent hover:underline" href="/trading">
          setup {shortHash(setupId)}
        </a>
      ))}
    </>
  )
}

function autoStageResult(run: SignalEngineRun) {
  return typeof run.autoStage === 'object' && run.autoStage !== null ? run.autoStage : run.autoStageResult
}

function HashChip({ label, value }: { label: string; value: string }) {
  return <span className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-accent">{label}:{shortHash(value)}</span>
}

function hashValue(value: { hash?: string; contentHash?: string }): string | null {
  return value.contentHash || value.hash || null
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function provenanceText(provenance: SignalEngineRun['provenance'], key: string): string | null {
  const value = provenance?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function provenanceChips(run: SignalEngineRun): string[] {
  const provenance = run.provenance ?? {}
  const chips = [
    run.asset || provenanceText(provenance, 'asset'),
    provenanceText(provenance, 'source'),
    provenanceText(provenance, 'model'),
    provenanceText(provenance, 'generatedAt') ? `generated ${shortDate(provenanceText(provenance, 'generatedAt')!)}` : null,
    provenanceText(provenance, 'inputHash') ? `input ${shortHash(provenanceText(provenance, 'inputHash')!)}` : null,
    provenanceText(provenance, 'dataHash') ? `data ${shortHash(provenanceText(provenance, 'dataHash')!)}` : null,
  ]
  return chips.filter((chip): chip is string => Boolean(chip))
}

function splitVersioned(value: string): [string, string] {
  const index = value.lastIndexOf('@')
  if (index <= 0) return [value, '1']
  return [value.slice(0, index), value.slice(index + 1)]
}

function findAlertItem(items: MarketDataAlertItem[], run: MarketDataAlertRun): MarketDataAlertItem | null {
  return items.find((item) =>
    item.asset === run.asset &&
    item.symbol.toUpperCase() === run.symbol?.toUpperCase() &&
    item.interval === run.interval &&
    (item.provider ?? '') === (run.provider ?? item.provider ?? '')
  ) ?? null
}

function numberSetting(value: unknown): number | undefined {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function qualityHints(run: MarketDataAlertRun, item?: MarketDataAlertItem | null): string[] {
  const hints = [
    run.feedback ? `feedback ${run.feedback.rating}` : null,
    item?.thresholds?.maxSignalAgeBars != null ? `age <= ${item.thresholds.maxSignalAgeBars}` : null,
    item?.thresholds?.minVolumeScore != null ? `volume >= ${item.thresholds.minVolumeScore}` : null,
    run.signals.some((signal) => signal.kind === 'ifvg') ? 'IFVG present' : null,
    run.signals.some((signal) => signal.kind === 'confluence') ? 'confluence present' : null,
  ]
  return hints.filter((hint): hint is string => Boolean(hint))
}

function signalHashesFromOutput(output: unknown): string[] {
  if (!output || typeof output !== 'object') return []
  const signals = (output as { signals?: unknown }).signals
  if (!Array.isArray(signals)) return []
  return signals.map((signal) => hashValue(signal as { hash?: string; contentHash?: string }) ?? signalHash(signal)).filter(Boolean)
}

function compareSignalHashes(original: SignalEngineSignal[], replayHashes: string[]): boolean | null {
  const originalHashes = original.map((signal) => hashValue(signal) ?? signalHash(signal)).filter(Boolean)
  if (originalHashes.length === 0 || replayHashes.length === 0) return null
  return originalHashes.join('|') === replayHashes.join('|')
}

function signalHash(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return String(record.canonicalPayloadHash ?? record.sourceHash ?? record.id ?? '')
}

function shortDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatThresholds(value: Record<string, unknown> | null): string {
  if (!value || Object.keys(value).length === 0) return 'default'
  return Object.entries(value).map(([key, v]) => `${key}=${String(v)}`).join(', ')
}

// ==================== Asset Providers Section ====================

function AssetProvidersSection({
  providers,
  assets,
  suggestions,
  onProviderChange,
}: {
  providers: Record<string, string>
  assets: string[]
  suggestions: string[]
  onProviderChange: (asset: string, provider: string) => void
}) {
  return (
    <ConfigSection
      title="Asset Providers"
      description="Configure provider names per asset class. Suggestions come from your current configuration."
    >
      <div className="space-y-3">
        {assets.map((asset) => {
          const selectedProvider = providers[asset] || ''
          const datalistId = `provider-suggestions-${asset}`
          return (
            <div key={asset} className="flex items-center gap-3">
              <span className="text-[13px] text-text w-24 shrink-0 font-medium">{ASSET_LABELS[asset] ?? asset}</span>
              <input
                className={`${inputClass} max-w-[220px]`}
                value={selectedProvider}
                list={datalistId}
                placeholder="provider name"
                onChange={(e) => onProviderChange(asset, e.target.value.trim())}
              />
              <datalist id={datalistId}>
                {suggestions.map((opt) => <option key={opt} value={opt} />)}
              </datalist>
              {selectedProvider === 'yfinance' && (
                <span className="text-[13px] text-text-muted/50 px-1">Free</span>
              )}
            </div>
          )
        })}
      </div>
    </ConfigSection>
  )
}

// ==================== API Keys Section ====================

function ApiKeysSection({
  providers,
  providerKeys,
  suggestions,
  onKeyChange,
}: {
  providers: Record<string, string>
  providerKeys: Record<string, string>
  suggestions: string[]
  onKeyChange: (keyName: string, value: string) => void
}) {
  const [customProviders, setCustomProviders] = useState<string[]>([])
  const providerNames = useMemo(() => {
    const keys = new Set<string>(Object.keys(providerKeys))
    for (const provider of Object.values(providers)) {
      if (provider?.trim()) keys.add(provider.trim())
    }
    for (const name of suggestions) keys.add(name)
    for (const name of customProviders) keys.add(name)
    return Array.from(keys).sort((a, b) => a.localeCompare(b))
  }, [customProviders, providerKeys, providers, suggestions])
  const [localKeys, setLocalKeys] = useState<Record<string, string>>({})
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({})
  const [newProviderName, setNewProviderName] = useState('')

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const provider of providerNames) next[provider] = providerKeys[provider] || ''
    setLocalKeys(next)
  }, [providerKeys, providerNames])

  const handleKeyChange = (keyName: string, value: string) => {
    setLocalKeys((prev) => ({ ...prev, [keyName]: value }))
    setTestStatus((prev) => ({ ...prev, [keyName]: 'idle' }))
    onKeyChange(keyName, value)
  }

  const testProvider = async (keyName: string) => {
    const key = localKeys[keyName]
    if (!key) return
    setTestStatus((prev) => ({ ...prev, [keyName]: 'testing' }))
    try {
      const result = await api.marketData.testProvider(keyName, key)
      setTestStatus((prev) => ({ ...prev, [keyName]: result.ok ? 'ok' : 'error' }))
    } catch {
      setTestStatus((prev) => ({ ...prev, [keyName]: 'error' }))
    }
  }

  const addProviderField = () => {
    const key = newProviderName.trim()
    if (!key || providerNames.includes(key)) return
    setCustomProviders((prev) => [...prev, key])
    setNewProviderName('')
  }

  return (
    <ConfigSection
      title="API Keys"
      description="Manage credentials by provider name. Provider names match the values set in Asset Providers."
    >
      <div className="space-y-4">
        {providerNames.map((key) => {
          const status = testStatus[key] || 'idle'
          return (
            <Field key={key} label={key} description="Provider API key">
              <div className="flex items-center gap-2">
                <input
                  className={inputClass}
                  type="password"
                  value={localKeys[key]}
                  onChange={(e) => handleKeyChange(key, e.target.value)}
                  placeholder="Not configured"
                />
                <TestButton
                  status={status}
                  disabled={!localKeys[key] || status === 'testing'}
                  onClick={() => testProvider(key)}
                />
              </div>
            </Field>
          )
        })}
        <div className="flex items-end gap-2">
          <Field label="Add provider" description="Create a new key field by provider name.">
            <input
              className={inputClass}
              value={newProviderName}
              list="provider-key-suggestions"
              placeholder="e.g. twelvedata"
              onChange={(e) => setNewProviderName(e.target.value)}
            />
            <datalist id="provider-key-suggestions">
              {suggestions.map((opt) => <option key={opt} value={opt} />)}
            </datalist>
          </Field>
          <button
            type="button"
            onClick={addProviderField}
            className="h-[34px] px-3 border border-border rounded-md text-[13px] text-text-muted hover:text-text hover:bg-bg-tertiary cursor-pointer"
          >
            Add
          </button>
        </div>
      </div>
    </ConfigSection>
  )
}

// ==================== Advanced Section ====================

function AdvancedSection({
  backend,
  apiUrl,
  onBackendChange,
  onApiUrlChange,
}: {
  backend: string
  apiUrl: string
  onBackendChange: (backend: string) => void
  onApiUrlChange: (url: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="py-6 border-b border-border/60 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 cursor-pointer text-left mb-1"
      >
        <h3 className="text-[14px] font-semibold text-text">Advanced</h3>
        <span className="text-[11px] text-text-muted/50">{expanded ? '\u25BC' : '\u25B6'}</span>
      </button>
      {!expanded && (
        <p className="text-[13px] text-text-muted/70">Data backend selection.</p>
      )}
      {expanded && (
        <div className="space-y-6 mt-4">
          {/* Data Backend */}
          <div>
            <p className="text-[13px] font-medium text-text mb-2">Data Backend</p>
            <div className="flex border border-border rounded-lg overflow-hidden w-fit mb-2">
              {(['typebb-sdk', 'openbb-api'] as const).map((opt, i) => (
                <button
                  key={opt}
                  onClick={() => onBackendChange(opt)}
                  className={`px-4 py-1.5 text-[13px] font-medium transition-colors cursor-pointer ${
                    i > 0 ? 'border-l border-border' : ''
                  } ${
                    backend === opt
                      ? 'bg-bg-tertiary text-text'
                      : 'text-text-muted hover:text-text'
                  }`}
                >
                  {opt === 'typebb-sdk' ? 'Built-in Engine (TypeBB)' : 'External OpenBB API'}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-text-muted/70">
              {backend === 'typebb-sdk'
                ? 'Uses the built-in TypeBB engine. No external process required.'
                : 'Connects to an external OpenBB-compatible HTTP endpoint.'}
            </p>
            {backend === 'openbb-api' && (
              <div className="mt-3">
                <Field label="API URL">
                  <input
                    className={inputClass}
                    value={apiUrl}
                    onChange={(e) => onApiUrlChange(e.target.value)}
                    placeholder="http://localhost:6900"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
