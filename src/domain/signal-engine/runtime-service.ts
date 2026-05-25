import type { SignalEngineConfig } from '../../core/config.js'
import type { UTAManagerSDK } from '../../services/uta-client/index.js'
import { OhlcvCacheStore, type OhlcvBar, type OhlcvPartitionKey } from '../market-data/ohlcv/index.js'
import type { TradeSetupService } from '../trading/setup-service.js'
import { autoStageSignalRun } from './auto-stage.js'
import { SignalEngineArtifactStore, type SignalEngineRunRecord } from './artifact-store.js'
import { buildSignalEngineArtifactPayload, runSignalEngine } from './service.js'
import { SignalEngineRiskTemplateStore, type SignalEngineRiskTemplateRecord } from './risk-template-store.js'
import { listBuiltInSignalEngineStrategies, toStrategySeed } from './strategy-catalog.js'
import { SignalEngineStrategyStore } from './strategy-store.js'
import type {
  ReplayBar,
  RiskTemplate,
  RunSignalEngineInput,
  SignalEngineArtifactResult,
  SignalEngineRun,
  StrategyPlugin,
} from './types.js'

type ResolveSignalAliceId = (input: {
  source: string
  symbol: string
  asset: SignalEngineRun['asset']
}) => Promise<string | null>

export interface SignalEngineRunRequest {
  asset?: string
  symbol?: string
  interval?: string
  provider?: string
  strategyId?: string
  strategyVersion?: string
  riskTemplateId?: string
  riskTemplateVersion?: string
  lookbackBars?: number
}

export interface SignalEngineReplayOverride {
  startedAt?: string
}

export interface SignalEngineServiceRunResult extends SignalEngineArtifactResult {
  record: SignalEngineRunRecord
}

export interface SignalEngineRunOnceResult {
  enabled: boolean
  skipped: boolean
  reason?: 'disabled' | 'already_processing'
  every: string
  itemCount: number
  results: SignalEngineServiceRunResult[]
  errors: Array<{ item: SignalEngineRunRequest; error: string }>
  startedAt: string
  finishedAt: string
}

export interface SignalEngineService {
  run(request: SignalEngineRunRequest): Promise<SignalEngineServiceRunResult>
  replay(runId: string, input?: SignalEngineReplayOverride): Promise<SignalEngineServiceRunResult>
  runOnce(): Promise<SignalEngineRunOnceResult>
}

export interface SignalEngineServiceDeps {
  config: SignalEngineConfig
  readConfig?: () => Promise<SignalEngineConfig>
  ohlcvCacheStore: OhlcvCacheStore
  artifactStore?: SignalEngineArtifactStore
  riskTemplateStore?: SignalEngineRiskTemplateStore
  strategyStore?: SignalEngineStrategyStore
  tradeSetupService?: Pick<TradeSetupService, 'createFromSignal' | 'stageSetup'>
  utaManager?: UTAManagerSDK
}

interface ResolvedRiskTemplate {
  template: RiskTemplate
  fallback: boolean
  requestedId: string
  requestedVersion: string
}

interface BuiltRunInput {
  input: RunSignalEngineInput
  riskTemplateResolution: ResolvedRiskTemplate
}

const SAFE_DEFAULT_RISK_TEMPLATE: RiskTemplate = {
  id: 'safe-default',
  version: '1',
  totalQuantity: '1',
  stopLossBps: '100',
  takeProfitBps: '200',
}

export function createSignalEngineService(deps: SignalEngineServiceDeps): SignalEngineService {
  const readConfig = deps.readConfig ?? (async () => deps.config)
  const builtInStrategies = listBuiltInSignalEngineStrategies()
  const builtInStrategiesByKey = new Map(builtInStrategies.map((entry) => [strategyKey(entry.id, entry.version), entry]))
  let processing = false
  let strategyStoreReady = false

  async function stores(config: SignalEngineConfig) {
    return {
      artifactStore: deps.artifactStore ?? new SignalEngineArtifactStore(config.dir),
      riskTemplateStore: deps.riskTemplateStore ?? new SignalEngineRiskTemplateStore(config.riskTemplatesPath),
      strategyStore: deps.strategyStore ?? new SignalEngineStrategyStore(config.strategiesPath),
    }
  }

  async function run(request: SignalEngineRunRequest): Promise<SignalEngineServiceRunResult> {
    const config = await readConfig()
    const item = normalizeRunRequest(request)
    const resolvedStores = await stores(config)
    await ensureStrategyStoreReady(resolvedStores.strategyStore)
    const built = await buildRunInput(item, resolvedStores.riskTemplateStore, resolvedStores.strategyStore)
    return await persistRun(
      built.input,
      resolvedStores.artifactStore,
      config,
      resolveAliceId,
      deps.tradeSetupService,
      undefined,
      built.riskTemplateResolution,
    )
  }

  async function replay(runId: string, input?: SignalEngineReplayOverride): Promise<SignalEngineServiceRunResult> {
    const config = await readConfig()
    const resolvedStores = await stores(config)
    await ensureStrategyStoreReady(resolvedStores.strategyStore)
    const artifact = await resolvedStores.artifactStore.getArtifact(runId)
    if (!artifact) throw new Error(`Signal engine run not found: ${runId}`)
    const original = parseArtifactInput(artifact.input)
    const strategy = await resolveStrategy(original.strategyId, original.strategyVersion, resolvedStores.strategyStore)
    const replayInput: RunSignalEngineInput = {
      asset: original.asset,
      symbol: original.symbol,
      interval: original.interval,
      provider: original.provider,
      strategy,
      riskTemplate: original.riskTemplate,
      bars: original.bars,
      startedAt: input?.startedAt,
    }
    return await persistRun(replayInput, resolvedStores.artifactStore, config, resolveAliceId, deps.tradeSetupService, runId)
  }

  async function runOnce(): Promise<SignalEngineRunOnceResult> {
    const startedAt = new Date().toISOString()
    const config = await readConfig()
    if (!config.enabled) {
      return {
        enabled: false,
        skipped: true,
        reason: 'disabled',
        every: config.every,
        itemCount: config.items.length,
        results: [],
        errors: [],
        startedAt,
        finishedAt: new Date().toISOString(),
      }
    }
    if (processing) {
      return {
        enabled: true,
        skipped: true,
        reason: 'already_processing',
        every: config.every,
        itemCount: config.items.length,
        results: [],
        errors: [],
        startedAt,
        finishedAt: new Date().toISOString(),
      }
    }

    processing = true
    const results: SignalEngineServiceRunResult[] = []
    const errors: Array<{ item: SignalEngineRunRequest; error: string }> = []
    try {
      for (const item of config.items) {
        if (item.enabled === false) continue
        try {
          results.push(await run(item))
        } catch (error) {
          errors.push({ item, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return {
        enabled: true,
        skipped: false,
        every: config.every,
        itemCount: config.items.length,
        results,
        errors,
        startedAt,
        finishedAt: new Date().toISOString(),
      }
    } finally {
      processing = false
    }
  }

  async function buildRunInput(
    item: Required<SignalEngineRunRequest>,
    riskTemplateStore: SignalEngineRiskTemplateStore,
    strategyStore: SignalEngineStrategyStore,
  ): Promise<BuiltRunInput> {
    const key: OhlcvPartitionKey = {
      asset: item.asset as OhlcvPartitionKey['asset'],
      symbol: item.symbol,
      interval: item.interval,
      provider: item.provider,
    }
    const cachedBars = await deps.ohlcvCacheStore.readAll(key)
    const bars = toReplayBars(cachedBars).slice(-item.lookbackBars)
    if (bars.length === 0) {
      throw new Error(`No closed OHLCV cache bars for ${key.provider}:${key.asset}:${key.symbol}:${key.interval}`)
    }
    const riskTemplateResolution = await resolveRiskTemplate(riskTemplateStore, item.riskTemplateId, item.riskTemplateVersion)
    return {
      input: {
        asset: key.asset,
        symbol: key.symbol,
        interval: key.interval,
        provider: key.provider,
        strategy: await resolveStrategy(item.strategyId, item.strategyVersion, strategyStore),
        riskTemplate: riskTemplateResolution.template,
        bars,
      },
      riskTemplateResolution,
    }
  }

  async function ensureStrategyStoreReady(store: SignalEngineStrategyStore): Promise<void> {
    if (strategyStoreReady) return
    await store.seedIfMissing(toStrategySeed(builtInStrategies))
    strategyStoreReady = true
  }

  async function resolveStrategy(
    id: string,
    version: string,
    store: SignalEngineStrategyStore,
  ): Promise<StrategyPlugin> {
    const builtIn = builtInStrategiesByKey.get(strategyKey(id, version))
    if (!builtIn) {
      throw new Error(`Unsupported signal engine strategy: ${id}@${version}`)
    }

    const registered = await store.get(id, version)
    if (!registered) {
      throw new Error(`Signal engine strategy is not registered: ${id}@${version}`)
    }
    if (registered.pluginHash !== builtIn.pluginHash) {
      throw new Error(
        `Signal engine strategy hash mismatch for ${id}@${version}: expected=${builtIn.pluginHash} actual=${registered.pluginHash}`,
      )
    }
    return builtIn.plugin
  }

  const resolveAliceId = deps.utaManager
    ? async (input: { source: string; symbol: string; asset: SignalEngineRun['asset'] }) => {
        const hits = await deps.utaManager!.searchContracts(input.symbol, input.asset)
        const hit = hits.find((candidate) => candidate.accountId === input.source)
        const contract = hit?.results[0]?.contract
        return typeof contract?.aliceId === 'string' ? contract.aliceId : null
      }
    : async () => null

  return { run, replay, runOnce }
}

async function persistRun(
  input: RunSignalEngineInput,
  artifactStore: SignalEngineArtifactStore,
  config: SignalEngineConfig,
  resolveAliceId: ResolveSignalAliceId,
  tradeSetupService?: Pick<TradeSetupService, 'createFromSignal' | 'stageSetup'>,
  replayOfRunId?: string,
  riskTemplateResolution?: ResolvedRiskTemplate,
): Promise<SignalEngineServiceRunResult> {
  const rawOutput = runSignalEngine(input)
  const output = tradeSetupService
    ? await autoStageSignalRun({
        run: rawOutput,
        config,
        riskTemplate: input.riskTemplate,
        tradeSetupService,
        resolveAliceId,
      })
    : rawOutput
  const payload = buildSignalEngineArtifactPayload(input, output)
  const metadata = {
    engineVersion: output.engineVersion,
    asset: output.asset,
    provider: output.provider,
    riskTemplateId: output.riskTemplateId,
    riskTemplateVersion: output.riskTemplateVersion,
    ...(riskTemplateResolution?.fallback ? {
      riskTemplateFallback: true,
      requestedRiskTemplateId: riskTemplateResolution.requestedId,
      requestedRiskTemplateVersion: riskTemplateResolution.requestedVersion,
      fallbackRiskTemplateId: SAFE_DEFAULT_RISK_TEMPLATE.id,
      fallbackRiskTemplateVersion: SAFE_DEFAULT_RISK_TEMPLATE.version,
    } : {}),
    ...(replayOfRunId ? { replayOfRunId } : {}),
  }
  const record = await artifactStore.appendRun({
    runId: replayOfRunId ? undefined : output.runId,
    status: output.status,
    strategyId: output.strategyId,
    strategyVersion: output.strategyVersion,
    symbol: output.symbol,
    interval: output.interval,
    replayOfRunId,
    input: payload.input,
    output: payload.output,
    events: payload.events,
    summary: output.summary,
    metadata,
  })
  return {
    status: output.status,
    strategyId: output.strategyId,
    strategyVersion: output.strategyVersion,
    symbol: output.symbol,
    interval: output.interval,
    input: payload.input,
    output,
    events: payload.events,
    summary: output.summary,
    metadata: {
      artifactPersisted: true,
      artifactRunId: record.runId,
      artifactDir: record.artifactDir,
      ...(replayOfRunId ? { replayOfRunId } : {}),
    },
    record,
  }
}

function normalizeRunRequest(request: SignalEngineRunRequest): Required<SignalEngineRunRequest> {
  const normalized = {
    asset: request.asset,
    symbol: request.symbol,
    interval: request.interval,
    provider: request.provider,
    strategyId: request.strategyId,
    strategyVersion: request.strategyVersion,
    riskTemplateId: request.riskTemplateId,
    riskTemplateVersion: request.riskTemplateVersion,
    lookbackBars: request.lookbackBars ?? 300,
  }
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined || value === '') throw new Error(`Signal engine run request missing ${key}`)
  }
  return normalized as Required<SignalEngineRunRequest>
}

function strategyKey(id: string, version: string): string {
  return `${id}@${version}`
}

async function resolveRiskTemplate(
  store: SignalEngineRiskTemplateStore,
  id: string,
  version: string,
): Promise<ResolvedRiskTemplate> {
  const entries = (await store.list()).entries
  const found = entries.find((entry) => entry.id === id && entry.version === version)
  if (found) {
    return {
      template: normalizeRiskTemplate(found),
      fallback: false,
      requestedId: id,
      requestedVersion: version,
    }
  }
  return {
    template: {
      ...SAFE_DEFAULT_RISK_TEMPLATE,
      id,
      version,
    },
    fallback: true,
    requestedId: id,
    requestedVersion: version,
  }
}

function normalizeRiskTemplate(record: SignalEngineRiskTemplateRecord): RiskTemplate {
  return {
    id: record.id,
    version: record.version,
    ...stringFields(record.template, ['totalQuantity', 'cashQty', 'stopLossBps', 'takeProfitBps']),
  }
}

function stringFields(value: Record<string, unknown>, fields: Array<keyof RiskTemplate>): Partial<RiskTemplate> {
  const out: Partial<RiskTemplate> = {}
  for (const field of fields) {
    const child = value[field]
    if (typeof child === 'string') out[field] = child
  }
  return out
}

function toReplayBars(bars: OhlcvBar[]): ReplayBar[] {
  return bars
    .filter((bar) => isClosedBar(bar))
    .map((bar) => ({
      time: bar.date,
      open: formatDecimal(bar.open),
      high: formatDecimal(bar.high),
      low: formatDecimal(bar.low),
      close: formatDecimal(bar.close),
      volume: formatDecimal(bar.volume ?? 0),
      ...(bar.vwap == null ? {} : { vwap: formatDecimal(bar.vwap) }),
      closed: true,
    }))
}

function isClosedBar(bar: OhlcvBar): boolean {
  const closed = bar.closed ?? bar.isClosed ?? bar.complete
  return closed === undefined || closed === true
}

function formatDecimal(value: number): string {
  // Keep this in sync if OHLCV starts carrying decimal-string values instead of JS numbers;
  // these strings are part of canonical hashes.
  return Number(value.toFixed(12)).toString()
}

interface ArtifactInput {
  asset: RunSignalEngineInput['asset']
  symbol: string
  interval: string
  provider: string
  strategyId: string
  strategyVersion: string
  riskTemplate: RiskTemplate
  bars: ReplayBar[]
}

function parseArtifactInput(value: unknown): ArtifactInput {
  if (!value || typeof value !== 'object') throw new Error('Signal engine artifact input is invalid')
  const input = value as Partial<ArtifactInput>
  if (!input.asset || !input.symbol || !input.interval || !input.provider) throw new Error('Signal engine artifact input is missing market fields')
  if (!input.strategyId || !input.strategyVersion) throw new Error('Signal engine artifact input is missing strategy fields')
  if (!input.riskTemplate || typeof input.riskTemplate !== 'object') throw new Error('Signal engine artifact input is missing risk template')
  if (!Array.isArray(input.bars)) throw new Error('Signal engine artifact input is missing bars')
  return input as ArtifactInput
}
