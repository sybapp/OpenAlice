import { fetchJson, headers } from './client'

export interface SignalEngineProvenance {
  source?: string
  provider?: string
  asset?: string
  symbol?: string
  interval?: string
  generatedAt?: string
  inputHash?: string
  dataHash?: string
  model?: string
  [key: string]: unknown
}

export interface SignalEngineSignal {
  id: string
  kind?: string
  label?: string
  message?: string
  direction?: 'bullish' | 'bearish' | 'neutral' | string
  confidence?: number
  hash?: string
  contentHash?: string
  provenance?: SignalEngineProvenance
  sourceHash?: string
  canonicalPayloadHash?: string
  closedBarTime?: string
  lmtPrice?: string
  stopLoss?: { price?: string; limitPrice?: string }
  takeProfit?: { price?: string }
  [key: string]: unknown
}

export interface SignalEngineAutoStageEntry {
  signalId: string
  status: 'staged' | 'failed' | string
  setupId?: string
  error?: string
}

export interface SignalEngineAutoStage {
  status: 'disabled' | 'skipped' | 'staged' | 'partial' | 'failed' | string
  enabled: boolean
  defaultUtaId?: string
  attempted?: number
  staged?: number
  failed?: number
  entries?: SignalEngineAutoStageEntry[]
  error?: string
}

export interface SignalEngineRun {
  runId: string
  status: 'triggered' | 'skipped' | 'error' | 'staged' | 'pending' | 'completed' | string
  startedAt?: string
  finishedAt?: string
  asset?: string
  symbol?: string
  interval?: string
  provider?: string
  summary?: string
  signals: SignalEngineSignal[]
  engineVersion?: string
  strategyId?: string
  strategyVersion?: string
  riskTemplateId?: string
  riskTemplateVersion?: string
  dataFingerprint?: string
  inputHash?: string
  outputHash?: string
  replayOfRunId?: string
  hash?: string
  contentHash?: string
  provenance?: SignalEngineProvenance
  autoStage?: boolean | SignalEngineAutoStage
  autoStageResult?: SignalEngineAutoStage
  autoStageStatus?: 'disabled' | 'skipped' | 'draft_created' | 'staged' | 'failed' | string
  autoStageError?: string
  stagedSetupId?: string
  setupId?: string
  error?: string
  [key: string]: unknown
}

export interface SignalEngineRunsResponse {
  count: number
  entries: SignalEngineRun[]
}

export interface SignalEngineConfigItem {
  asset: 'equity' | 'crypto' | 'currency' | 'commodity' | string
  symbol: string
  interval: string
  provider?: string
  enabled?: boolean
  strategyId: string
  strategyVersion: string
  riskTemplateId: string
  riskTemplateVersion: string
  lookbackBars: number
}

export interface SignalEngineConfig {
  enabled: boolean
  dir: string
  every: string
  strategiesPath: string
  riskTemplatesPath: string
  closedBarsOnly: true
  autoStage: {
    enabled: boolean
    defaultUtaId?: string
    allowedUtaModes: Array<'simulator' | 'paper' | string>
    neverPush: true
  }
  defaults: {
    orderType: 'LMT'
    requireStopLoss: true
  }
  items: SignalEngineConfigItem[]
}

export interface SignalEngineStrategyRecord {
  id: string
  version: string
  manifest: Record<string, unknown>
  pluginHash: string
  createdAt: string
  updatedAt: string
}

export interface SignalEngineRiskTemplateRecord {
  id: string
  version: string
  createdAt: string
  template: Record<string, unknown>
  templateHash: string
}

export interface SignalEngineCatalogResponse<T> {
  count: number
  entries: T[]
}

export interface SignalEngineArtifact {
  runId: string
  createdAt: string
  artifactDir: string
  manifest: Record<string, unknown>
  input: unknown
  output: unknown
  events: unknown[]
  hashes: Record<string, string>
}

export interface SignalEngineEventsResponse {
  runId: string
  count: number
  events: unknown[]
}

export const signalsApi = {
  config(): Promise<SignalEngineConfig> {
    return fetchJson('/api/signal-engine/config')
  },
  saveConfig(config: SignalEngineConfig): Promise<SignalEngineConfig> {
    return fetchJson('/api/signal-engine/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify(config),
    })
  },
  strategies(): Promise<SignalEngineCatalogResponse<SignalEngineStrategyRecord>> {
    return fetchJson('/api/signal-engine/strategies')
  },
  riskTemplates(): Promise<SignalEngineCatalogResponse<SignalEngineRiskTemplateRecord>> {
    return fetchJson('/api/signal-engine/risk-templates')
  },
  runs(params: { limit?: number; asset?: string; symbol?: string; interval?: string; status?: string } = {}): Promise<SignalEngineRunsResponse> {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') qs.set(key, String(value))
    }
    return fetchJson(`/api/signal-engine/runs${qs.size ? `?${qs}` : ''}`)
  },
  run(runId: string): Promise<SignalEngineRun> {
    return fetchJson(`/api/signal-engine/runs/${encodeURIComponent(runId)}`)
  },
  replay(runId: string, body: { startedAt?: string } = {}): Promise<SignalEngineRun> {
    return fetchJson(`/api/signal-engine/replay/${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  },
  artifact(runId: string): Promise<SignalEngineArtifact> {
    return fetchJson(`/api/signal-engine/artifacts/${encodeURIComponent(runId)}`)
  },
  events(runId: string): Promise<SignalEngineEventsResponse> {
    const qs = new URLSearchParams({ runId })
    return fetchJson(`/api/signal-engine/events?${qs}`)
  },
}
