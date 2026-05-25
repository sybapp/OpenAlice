import { Hono } from 'hono'
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  loadConfig,
  readSignalEngineConfig,
  writeConfigSection,
  type SignalEngineConfig,
} from '../../core/config.js'
import type { EngineContext } from '../../core/types.js'
import {
  SignalEngineArtifactStore,
  type AppendSignalEngineRunInput,
} from '../../domain/signal-engine/artifact-store.js'
import { SignalEngineRiskTemplateStore } from '../../domain/signal-engine/risk-template-store.js'
import { SignalEngineStrategyStore } from '../../domain/signal-engine/strategy-store.js'
import type { SignalEngineReplayOverride } from '../../domain/signal-engine/runtime-service.js'

interface SignalEngineServiceResult {
  status?: string
  strategyId?: string
  strategyVersion?: string
  symbol?: string
  interval?: string
  input?: unknown
  output?: unknown
  events?: unknown[]
  summary?: string
  error?: string
  metadata?: Record<string, unknown>
}

export function createSignalEngineRoutes(ctx: EngineContext): Hono {
  const app = new Hono()

  app.get('/config', async (c) => {
    try {
      return c.json(await readSignalEngineConfig())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.put('/config', async (c) => {
    try {
      const body = await c.req.json()
      const validated = await writeConfigSection('signalEngine', body)
      const fresh = await loadConfig()
      Object.assign(ctx.config, fresh)
      return c.json(validated)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.get('/strategies', async (c) => {
    try {
      const stores = await createStores()
      return c.json(await stores.strategies.list())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.get('/risk-templates', async (c) => {
    try {
      const stores = await createStores()
      return c.json(await stores.riskTemplates.list())
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.get('/runs', async (c) => {
    try {
      const stores = await createStores()
      const listed = await stores.artifacts.listRuns({
        limit: parseLimit(c.req.query('limit')),
        status: c.req.query('status'),
        strategyId: c.req.query('strategyId'),
        strategyVersion: c.req.query('strategyVersion'),
        symbol: c.req.query('symbol'),
        interval: c.req.query('interval'),
        replayOfRunId: c.req.query('replayOfRunId'),
      })
      const entries = await Promise.all(listed.entries.map((record) => hydrateRunRecord(stores.artifacts, record)))
      return c.json({ count: entries.length, entries })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.get('/runs/:runId', async (c) => {
    try {
      const stores = await createStores()
      const record = await stores.artifacts.getRun(c.req.param('runId'))
      if (!record) return c.json({ error: 'Run not found' }, 404)
      return c.json(record)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.post('/run', async (c) => {
    try {
      const request = await c.req.json()
      const service = getSignalEngineService(ctx)
      if (!service) return c.json({ error: 'Signal engine service is unavailable' }, 503)
      const result = await service.run(request)
      const persisted = await persistedRecord(result)
      if (persisted) return c.json(persisted, 201)
      const stores = await createStores()
      const record = await stores.artifacts.appendRun(toRunInput(request, result))
      return c.json(record, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/replay/:runId', async (c) => {
    try {
      const runId = c.req.param('runId')
      const stores = await createStores()
      const original = await stores.artifacts.getArtifact(runId)
      if (!original) return c.json({ error: 'Run not found' }, 404)
      const request = await readOptionalJson(c)
      const service = getSignalEngineService(ctx)
      if (!service) return c.json({ error: 'Signal engine service is unavailable' }, 503)
      const replayOverride = parseReplayOverride(request)
      const result = await service.replay(runId, replayOverride)
      const persisted = await persistedRecord(result)
      if (persisted) return c.json(persisted, 201)
      const record = await stores.artifacts.appendRun({
        ...toRunInput({
          replayOfRunId: runId,
          originalInput: original.input,
          ...(replayOverride ? { override: replayOverride } : {}),
        }, result),
        replayOfRunId: runId,
      })
      return c.json(record, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get('/artifacts/:runId', async (c) => {
    try {
      const stores = await createStores()
      const artifact = await stores.artifacts.getArtifact(c.req.param('runId'))
      if (!artifact) return c.json({ error: 'Run not found' }, 404)
      return c.json(artifact)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.get('/events', async (c) => {
    try {
      const runId = c.req.query('runId')
      if (!runId) return c.json({ error: 'runId query parameter is required' }, 400)
      const stores = await createStores()
      const events = await stores.artifacts.getEvents(runId)
      if (!events) return c.json({ error: 'Run not found' }, 404)
      return c.json({ runId, count: events.length, events })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  return app
}

async function createStores() {
  const config = await readSignalEngineConfig()
  return {
    artifacts: new SignalEngineArtifactStore(signalEngineRoot(config)),
    strategies: new SignalEngineStrategyStore(config.strategiesPath),
    riskTemplates: new SignalEngineRiskTemplateStore(config.riskTemplatesPath),
  }
}

function signalEngineRoot(config: SignalEngineConfig): string {
  return config.dir || dirname(config.riskTemplatesPath) || 'data/signal-engine'
}

function getSignalEngineService(ctx: EngineContext): EngineContext['signalEngineService'] {
  const candidate = ctx.signalEngineService
  if (!candidate || typeof candidate !== 'object') return undefined
  return candidate
}

function toRunInput(request: unknown, result: unknown): AppendSignalEngineRunInput {
  const normalized = normalizeServiceResult(result)
  return {
    status: normalized.status ?? 'completed',
    strategyId: normalized.strategyId ?? stringField(request, 'strategyId'),
    strategyVersion: normalized.strategyVersion ?? stringField(request, 'strategyVersion'),
    symbol: normalized.symbol ?? stringField(request, 'symbol'),
    interval: normalized.interval ?? stringField(request, 'interval'),
    input: normalized.input ?? request,
    output: normalized.output ?? result,
    events: normalized.events ?? [],
    summary: normalized.summary,
    error: normalized.error,
    metadata: normalized.metadata,
  }
}

function normalizeServiceResult(result: unknown): SignalEngineServiceResult {
  if (!result || typeof result !== 'object') return {}
  const record = result as Record<string, unknown>
  return {
    status: typeof record.status === 'string' ? record.status : undefined,
    strategyId: typeof record.strategyId === 'string' ? record.strategyId : undefined,
    strategyVersion: typeof record.strategyVersion === 'string' ? record.strategyVersion : undefined,
    symbol: typeof record.symbol === 'string' ? record.symbol : undefined,
    interval: typeof record.interval === 'string' ? record.interval : undefined,
    input: record.input,
    output: record.output,
    events: Array.isArray(record.events) ? record.events : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : undefined,
  }
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const fieldValue = (value as Record<string, unknown>)[field]
  return typeof fieldValue === 'string' ? fieldValue : undefined
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseReplayOverride(value: unknown): SignalEngineReplayOverride | undefined {
  const record = objectRecord(value)
  const startedAt = record.startedAt
  return typeof startedAt === 'string' ? { startedAt } : undefined
}

async function persistedRecord(value: unknown): Promise<unknown | null> {
  if (!value || typeof value !== 'object') return null
  const metadata = (value as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return null
  if ((metadata as { artifactPersisted?: unknown }).artifactPersisted !== true) return null
  const record = (value as { record?: unknown }).record
  if (!record || typeof record !== 'object') return null
  if (typeof (record as { runId?: unknown }).runId !== 'string') return null
  const artifactDir = (record as { artifactDir?: unknown }).artifactDir
  if (typeof artifactDir !== 'string' || artifactDir.trim() === '') return null
  try {
    await access(`${artifactDir}/manifest.json`)
    return record
  } catch {
    return null
  }
}

async function hydrateRunRecord(
  store: SignalEngineArtifactStore,
  record: Awaited<ReturnType<SignalEngineArtifactStore['listRuns']>>['entries'][number],
) {
  try {
    const artifact = await store.getArtifact(record.runId)
    const output = objectRecord(artifact?.output)
    const metadata = objectRecord(record.metadata)
    return {
      ...record,
      ...pickOutputFields(output, [
        'engineVersion',
        'startedAt',
        'finishedAt',
        'asset',
        'provider',
        'riskTemplateId',
        'riskTemplateVersion',
        'closedBarsOnly',
        'dataFingerprint',
        'autoStageStatus',
        'autoStageError',
        'autoStage',
      ]),
      status: typeof output.status === 'string' ? output.status : record.status,
      strategyId: typeof output.strategyId === 'string' ? output.strategyId : record.strategyId,
      strategyVersion: typeof output.strategyVersion === 'string' ? output.strategyVersion : record.strategyVersion,
      symbol: typeof output.symbol === 'string' ? output.symbol : record.symbol,
      interval: typeof output.interval === 'string' ? output.interval : record.interval,
      summary: typeof output.summary === 'string' ? output.summary : record.summary,
      signals: Array.isArray(output.signals) ? output.signals : [],
      provenance: {
        ...(metadata.engineVersion ? { engineVersion: metadata.engineVersion } : {}),
        ...(metadata.asset ?? output.asset ? { asset: metadata.asset ?? output.asset } : {}),
        ...(metadata.provider ?? output.provider ? { provider: metadata.provider ?? output.provider } : {}),
        ...(metadata.riskTemplateId ? { riskTemplateId: metadata.riskTemplateId } : {}),
        ...(metadata.riskTemplateVersion ? { riskTemplateVersion: metadata.riskTemplateVersion } : {}),
        ...(typeof output.inputHash === 'string' ? { inputHash: output.inputHash } : {}),
        ...(typeof output.dataFingerprint === 'string' ? { dataHash: output.dataFingerprint } : {}),
      },
    }
  } catch {
    return { ...record, signals: [] }
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pickOutputFields(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields
    .filter((field) => record[field] !== undefined)
    .map((field) => [field, record[field]]))
}

async function readOptionalJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}
