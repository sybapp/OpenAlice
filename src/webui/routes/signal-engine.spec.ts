import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineContext } from '../../core/types.js'
import { createSignalEngineRoutes } from './signal-engine.js'

const mocks = vi.hoisted(() => ({
  signalEngineConfig: undefined as any,
  writeConfigSection: vi.fn(async (_section: string, data: unknown) => data),
}))

vi.mock('../../core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/config.js')>('../../core/config.js')
  return {
    ...actual,
    readSignalEngineConfig: vi.fn(async () => mocks.signalEngineConfig),
    writeConfigSection: mocks.writeConfigSection,
    loadConfig: vi.fn(async () => ({ signalEngine: mocks.signalEngineConfig })),
  }
})

function makeCtx(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    config: {},
    hookEngine: { run: vi.fn(async () => {}) },
    ...overrides,
  } as unknown as EngineContext
}

async function req(
  routes: ReturnType<typeof createSignalEngineRoutes>,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
) {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await routes.request(path, init)
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

function baseConfig(root: string) {
  return {
    enabled: true,
    dir: root,
    every: '5m',
    strategiesPath: join(root, 'strategies.json'),
    riskTemplatesPath: join(root, 'risk-templates.jsonl'),
    closedBarsOnly: true,
    autoStage: {
      enabled: false,
      allowedUtaModes: ['simulator', 'paper'],
      neverPush: true,
    },
    defaults: {
      orderType: 'LMT',
      requireStopLoss: true,
    },
    items: [],
  }
}

function serviceResult(root: string, overrides: Record<string, unknown> = {}) {
  const artifactDir = join(root, 'artifacts', '2026-05-11', 'sr_mock')
  const output = {
    runId: 'sr_mock',
    engineVersion: '1',
    status: 'completed',
    startedAt: '2026-05-11T00:00:00.000Z',
    finishedAt: '2026-05-11T00:00:00.000Z',
    asset: 'equity',
    strategyId: 'svp',
    strategyVersion: '1.0.0',
    symbol: 'QQQ',
    interval: '5m',
    provider: 'fixture',
    riskTemplateId: 'risk',
    riskTemplateVersion: '1',
    closedBarsOnly: true,
    dataFingerprint: 'data-hash',
    inputHash: 'input-hash',
    outputHash: 'output-hash',
    signals: [{ id: 'sig-1', side: 'long' }],
    summary: 'one signal',
  }
  return {
    status: 'completed' as const,
    strategyId: 'svp',
    strategyVersion: '1.0.0',
    symbol: 'QQQ',
    interval: '5m',
    input: { request: true },
    output,
    events: [{ type: 'signal.generated', at: '2026-05-11T00:00:00.000Z' }],
    summary: 'one signal',
    metadata: { source: 'test', artifactPersisted: true },
    record: {
      runId: 'sr_mock',
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z',
      status: 'completed',
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
      artifactDir,
      artifactHash: 'manifest-hash',
      inputHash: 'input-hash',
      outputHash: 'output-hash',
      eventsHash: 'events-hash',
      summary: 'one signal',
      metadata: { source: 'test' },
    },
    ...overrides,
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('signal-engine routes', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-signal-engine-routes-'))
    mocks.signalEngineConfig = baseConfig(root)
    mocks.writeConfigSection.mockImplementation(async (_section: string, data: unknown) => {
      const actual = await vi.importActual<typeof import('../../core/config.js')>('../../core/config.js')
      mocks.signalEngineConfig = actual.signalEngineSchema.parse(data)
      return mocks.signalEngineConfig
    })
    mocks.writeConfigSection.mockClear()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('GET and PUT /config enforce closedBarsOnly and neverPush safety gates', async () => {
    const ctx = makeCtx()
    const routes = createSignalEngineRoutes(ctx)

    const current = await req(routes, 'GET', '/config')
    expect(current.status).toBe(200)
    expect(current.body).toMatchObject({
      closedBarsOnly: true,
      autoStage: { neverPush: true },
      defaults: { orderType: 'LMT', requireStopLoss: true },
    })

    const updated = await req(routes, 'PUT', '/config', {
      enabled: true,
      dir: root,
      strategiesPath: join(root, 'strategies.json'),
      riskTemplatesPath: join(root, 'risk-templates.jsonl'),
      closedBarsOnly: false,
      autoStage: { enabled: true, neverPush: false, allowedUtaModes: [] },
      defaults: { orderType: 'LMT', requireStopLoss: false },
    })

    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({
      closedBarsOnly: true,
      autoStage: { enabled: true, neverPush: true, allowedUtaModes: ['simulator', 'paper'] },
      defaults: { orderType: 'LMT', requireStopLoss: true },
    })
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('signalEngine', expect.objectContaining({
      closedBarsOnly: false,
    }))
  })

  it('PUT /config returns validation errors', async () => {
    const routes = createSignalEngineRoutes(makeCtx())

    const result = await req(routes, 'PUT', '/config', {
      items: [{ asset: 'equity', symbol: '', interval: '5m' }],
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: 'Validation failed' })
    expect(result.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(['symbol']) }),
    ]))
  })

  it('POST /run calls ctx.signalEngineService, records artifacts, and lists runs', async () => {
    const signalEngineService = {
      run: vi.fn(async (input: unknown) => serviceResult(root, { input })),
    }
    const routes = createSignalEngineRoutes(makeCtx({ signalEngineService } as unknown as Partial<EngineContext>))
    const payload = {
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
      bars: [{ t: '2026-05-11T00:00:00.000Z', close: 440 }],
    }

    const created = await req(routes, 'POST', '/run', payload)
    const listed = await req(routes, 'GET', '/runs?symbol=qqq&limit=10')

    expect(created.status).toBe(201)
    expect(signalEngineService.run).toHaveBeenCalledWith(payload)
    expect(created.body).toMatchObject({
      status: 'completed',
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
      summary: 'one signal',
      metadata: { source: 'test' },
    })
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      count: 1,
      entries: [expect.objectContaining({
        runId: created.body.runId,
        symbol: 'QQQ',
        asset: 'equity',
        provider: 'fixture',
        signals: [expect.objectContaining({ id: 'sig-1' })],
        provenance: expect.objectContaining({
          asset: 'equity',
          provider: 'fixture',
          inputHash: 'input-hash',
          dataHash: 'data-hash',
        }),
      })],
    })
  })

  it('GET /artifacts/:runId returns canonical artifacts whose hashes match file bytes', async () => {
    const signalEngineService = {
      run: vi.fn(async (input: unknown) => serviceResult(root, { input })),
    }
    const routes = createSignalEngineRoutes(makeCtx({ signalEngineService } as unknown as Partial<EngineContext>))
    const created = await req(routes, 'POST', '/run', {
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
    })

    const artifact = await req(routes, 'GET', `/artifacts/${created.body.runId}`)

    expect(artifact.status).toBe(200)
    expect(artifact.body).toMatchObject({
      runId: created.body.runId,
      manifest: {
        runId: created.body.runId,
        files: {
          'input.canonical.json': { sha256: created.body.inputHash },
          'output.canonical.json': { sha256: created.body.outputHash },
          'events.canonical.jsonl': { sha256: created.body.eventsHash },
        },
      },
      hashes: {
        'manifest.json': created.body.artifactHash,
        'input.canonical.json': created.body.inputHash,
        'output.canonical.json': created.body.outputHash,
        'events.canonical.jsonl': created.body.eventsHash,
      },
    })
    expect(created.body.artifactHash).toBe(await sha256File(join(created.body.artifactDir, 'manifest.json')))
    expect(created.body.inputHash).toBe(await sha256File(join(created.body.artifactDir, 'input.canonical.json')))
    expect(created.body.outputHash).toBe(await sha256File(join(created.body.artifactDir, 'output.canonical.json')))
    expect(created.body.eventsHash).toBe(await sha256File(join(created.body.artifactDir, 'events.canonical.jsonl')))
  })

  it('POST /replay/:runId calls ctx.signalEngineService and links the replay run', async () => {
    let replayOfRunId = ''
    const signalEngineService = {
      run: vi.fn(async (input: unknown) => serviceResult(root, { input })),
      replay: vi.fn(async (runId: string, input: unknown) => {
        replayOfRunId = runId
        return serviceResult(root, {
        input,
        record: {
          runId: 'sr_replay',
          createdAt: '2026-05-11T00:01:00.000Z',
          updatedAt: '2026-05-11T00:01:00.000Z',
          status: 'completed',
          strategyId: 'svp',
          strategyVersion: '1.0.0',
          symbol: 'QQQ',
          interval: '5m',
          replayOfRunId,
          artifactDir: join(root, 'artifacts', '2026-05-11', 'sr_replay'),
          artifactHash: 'manifest-replay-hash',
          inputHash: 'input-replay-hash',
          outputHash: 'output-replay-hash',
          eventsHash: 'events-replay-hash',
          summary: 'one signal',
          metadata: { source: 'test' },
        },
        output: { replayed: true },
        events: [{ type: 'signal.replayed' }],
      })
      }),
    }
    const routes = createSignalEngineRoutes(makeCtx({ signalEngineService } as unknown as Partial<EngineContext>))
    const original = await req(routes, 'POST', '/run', {
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
    })

    const replay = await req(routes, 'POST', `/replay/${original.body.runId}`, { startedAt: '2026-05-10T00:00:00.000Z' })

    expect(replay.status).toBe(201)
    expect(signalEngineService.replay).toHaveBeenCalledWith(original.body.runId, { startedAt: '2026-05-10T00:00:00.000Z' })
    expect(replay.body).toMatchObject({
      replayOfRunId: original.body.runId,
      status: 'completed',
      strategyId: 'svp',
      strategyVersion: '1.0.0',
    })
  })

  it('GET /events?runId= returns recorded events', async () => {
    const signalEngineService = {
      run: vi.fn(async (input: unknown) => serviceResult(root, {
        input,
        events: [{ type: 'signal-engine.run.completed', at: '2026-05-11T00:00:00.000Z' }],
      })),
    }
    const routes = createSignalEngineRoutes(makeCtx({ signalEngineService } as unknown as Partial<EngineContext>))
    const created = await req(routes, 'POST', '/run', {
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
    })

    const events = await req(routes, 'GET', `/events?runId=${created.body.runId}`)

    expect(events.status).toBe(200)
    expect(events.body).toEqual({
      runId: created.body.runId,
      count: 1,
      events: [expect.objectContaining({ type: 'signal-engine.run.completed' })],
    })
  })

  it('POST /run returns 503 when the in-process service is unavailable', async () => {
    const routes = createSignalEngineRoutes(makeCtx())

    const result = await req(routes, 'POST', '/run', {
      strategyId: 'svp',
      strategyVersion: '1.0.0',
      symbol: 'QQQ',
      interval: '5m',
    })

    expect(result).toMatchObject({
      status: 503,
      body: { error: 'Signal engine service is unavailable' },
    })
  })

  it('returns 404 for missing run artifact, events, and replay requests', async () => {
    const routes = createSignalEngineRoutes(makeCtx())

    const artifact = await req(routes, 'GET', '/artifacts/missing-run')
    const events = await req(routes, 'GET', '/events?runId=missing-run')
    const replay = await req(routes, 'POST', '/replay/missing-run', {})

    expect(artifact).toMatchObject({ status: 404, body: { error: 'Run not found' } })
    expect(events).toMatchObject({ status: 404, body: { error: 'Run not found' } })
    expect(replay).toMatchObject({ status: 404, body: { error: 'Run not found' } })
  })

  it('returns validation error when events runId query is missing', async () => {
    const routes = createSignalEngineRoutes(makeCtx())

    const result = await req(routes, 'GET', '/events')

    expect(result).toMatchObject({
      status: 400,
      body: { error: 'runId query parameter is required' },
    })
  })
})
