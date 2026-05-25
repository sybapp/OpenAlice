import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJson, canonicalJsonLine, sha256Hex } from './canonical-json.js'

export const DEFAULT_SIGNAL_ENGINE_ROOT = 'data/signal-engine'

export interface SignalEngineCanonicalArtifact {
  runId: string
  createdAt: string
  artifactDir: string
  manifest: SignalEngineArtifactManifest
  input: unknown
  output: unknown
  events: unknown[]
  hashes: Record<string, string>
}

export interface SignalEngineArtifactManifest {
  runId: string
  createdAt: string
  files: Record<string, { sha256: string; bytes: number }>
  metadata?: Record<string, unknown>
}

export interface SignalEngineRunRecord {
  runId: string
  createdAt: string
  updatedAt: string
  status: string
  strategyId?: string
  strategyVersion?: string
  symbol?: string
  interval?: string
  replayOfRunId?: string
  artifactDir: string
  artifactHash: string
  inputHash: string
  outputHash: string
  eventsHash: string
  summary?: string
  error?: string
  metadata?: Record<string, unknown>
}

export interface AppendSignalEngineRunInput {
  runId?: string
  status?: string
  strategyId?: string
  strategyVersion?: string
  symbol?: string
  interval?: string
  replayOfRunId?: string
  input: unknown
  output: unknown
  events?: unknown[]
  summary?: string
  error?: string
  metadata?: Record<string, unknown>
  now?: () => Date
}

export interface ListSignalEngineRunsOptions {
  limit?: number
  status?: string
  strategyId?: string
  strategyVersion?: string
  symbol?: string
  interval?: string
  replayOfRunId?: string
}

export class SignalEngineArtifactStore {
  constructor(private readonly root = DEFAULT_SIGNAL_ENGINE_ROOT) {}

  async appendRun(input: AppendSignalEngineRunInput): Promise<SignalEngineRunRecord> {
    const createdAt = (input.now?.() ?? new Date()).toISOString()
    const runId = input.runId ?? sha256(canonicalJson({
      input: input.input,
      output: input.output,
      events: input.events ?? [],
      ...(input.replayOfRunId ? { replayOfRunId: input.replayOfRunId } : {}),
    })).slice(0, 32)
    const artifact = await this.writeArtifact({
      runId,
      createdAt,
      input: input.input,
      output: input.output,
      events: input.events ?? [],
      metadata: input.metadata,
    })
    const record: SignalEngineRunRecord = {
      runId,
      createdAt,
      updatedAt: createdAt,
      status: input.status ?? 'completed',
      ...(input.strategyId && { strategyId: input.strategyId }),
      ...(input.strategyVersion && { strategyVersion: input.strategyVersion }),
      ...(input.symbol && { symbol: input.symbol }),
      ...(input.interval && { interval: input.interval }),
      ...(input.replayOfRunId && { replayOfRunId: input.replayOfRunId }),
      artifactDir: artifact.artifactDir,
      artifactHash: artifact.hashes['manifest.json'],
      inputHash: artifact.hashes['input.canonical.json'],
      outputHash: artifact.hashes['output.canonical.json'],
      eventsHash: artifact.hashes['events.canonical.jsonl'],
      ...(input.summary && { summary: input.summary }),
      ...(input.error && { error: input.error }),
      ...(input.metadata && { metadata: input.metadata }),
    }
    await mkdir(dirname(this.runsPath), { recursive: true })
    await appendFile(this.runsPath, JSON.stringify(record) + '\n', 'utf-8')
    return record
  }

  async listRuns(options: ListSignalEngineRunsOptions = {}): Promise<{ count: number; entries: SignalEngineRunRecord[] }> {
    const limit = clampLimit(options.limit)
    const entries = (await this.readRuns())
      .filter((record) => !options.status || record.status === options.status)
      .filter((record) => !options.strategyId || record.strategyId === options.strategyId)
      .filter((record) => !options.strategyVersion || record.strategyVersion === options.strategyVersion)
      .filter((record) => !options.symbol || record.symbol?.toUpperCase() === options.symbol.toUpperCase())
      .filter((record) => !options.interval || record.interval === options.interval)
      .filter((record) => !options.replayOfRunId || record.replayOfRunId === options.replayOfRunId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
    return { count: entries.length, entries }
  }

  async getRun(runId: string): Promise<SignalEngineRunRecord | null> {
    const runs = await this.readRuns()
    return runs.find((record) => record.runId === runId) ?? null
  }

  async getArtifact(runId: string): Promise<SignalEngineCanonicalArtifact | null> {
    const record = await this.getRun(runId)
    if (!record) return null
    const artifactDir = record.artifactDir
    const [manifest, input, output, events] = await Promise.all([
      readJson<SignalEngineArtifactManifest>(join(artifactDir, 'manifest.json')),
      readJson<unknown>(join(artifactDir, 'input.canonical.json')),
      readJson<unknown>(join(artifactDir, 'output.canonical.json')),
      readJsonl(join(artifactDir, 'events.canonical.jsonl')),
    ])
    const hashes = {
      'manifest.json': await readHash(join(artifactDir, 'manifest.json.sha256')),
      'input.canonical.json': await readHash(join(artifactDir, 'input.canonical.json.sha256')),
      'output.canonical.json': await readHash(join(artifactDir, 'output.canonical.json.sha256')),
      'events.canonical.jsonl': await readHash(join(artifactDir, 'events.canonical.jsonl.sha256')),
    }
    return {
      runId,
      createdAt: record.createdAt,
      artifactDir,
      manifest,
      input,
      output,
      events,
      hashes,
    }
  }

  async getEvents(runId: string): Promise<unknown[] | null> {
    const record = await this.getRun(runId)
    if (!record) return null
    return await readJsonl(join(record.artifactDir, 'events.canonical.jsonl'))
  }

  private get runsPath(): string {
    return join(this.root, 'runs.jsonl')
  }

  private async readRuns(): Promise<SignalEngineRunRecord[]> {
    try {
      const raw = await readFile(this.runsPath, 'utf-8')
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseRunRecord(line))
        .filter((record): record is SignalEngineRunRecord => record !== null)
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
  }

  private async writeArtifact(input: {
    runId: string
    createdAt: string
    input: unknown
    output: unknown
    events: unknown[]
    metadata?: Record<string, unknown>
  }): Promise<{ artifactDir: string; manifest: SignalEngineArtifactManifest; hashes: Record<string, string> }> {
    const artifactDir = join(this.root, 'artifacts', datePath(input.createdAt), input.runId)
    await mkdir(artifactDir, { recursive: true })

    const inputFile = canonicalJson(input.input)
    const outputFile = canonicalJson(input.output)
    const eventsFile = input.events.map((event) => canonicalJsonLine(event)).join('')
    const fileEntries = {
      'input.canonical.json': { content: inputFile },
      'output.canonical.json': { content: outputFile },
      'events.canonical.jsonl': { content: eventsFile },
    }
    const fileHashes: Record<string, string> = Object.fromEntries(
      Object.entries(fileEntries).map(([name, entry]) => [name, sha256(entry.content)]),
    )
    const manifest: SignalEngineArtifactManifest = {
      runId: input.runId,
      createdAt: input.createdAt,
      files: Object.fromEntries(
        Object.entries(fileEntries).map(([name, entry]) => [name, {
          sha256: fileHashes[name],
          bytes: Buffer.byteLength(entry.content),
        }]),
      ),
      ...(input.metadata && { metadata: input.metadata }),
    }
    const manifestFile = canonicalJson(manifest)
    const hashes: Record<string, string> = {
      ...fileHashes,
      'manifest.json': sha256(manifestFile),
    }

    await Promise.all([
      writeCanonicalWithHash(join(artifactDir, 'input.canonical.json'), inputFile, hashes['input.canonical.json']),
      writeCanonicalWithHash(join(artifactDir, 'output.canonical.json'), outputFile, hashes['output.canonical.json']),
      writeCanonicalWithHash(join(artifactDir, 'events.canonical.jsonl'), eventsFile, hashes['events.canonical.jsonl']),
      writeCanonicalWithHash(join(artifactDir, 'manifest.json'), manifestFile, hashes['manifest.json']),
    ])

    return { artifactDir, manifest, hashes }
  }
}

function parseRunRecord(line: string): SignalEngineRunRecord | null {
  try {
    const value = JSON.parse(line) as Partial<SignalEngineRunRecord>
    if (!value.runId || !value.createdAt || !value.status || !value.artifactDir) return null
    if (!value.artifactHash || !value.inputHash || !value.outputHash || !value.eventsHash) return null
    return {
      runId: value.runId,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt ?? value.createdAt,
      status: value.status,
      strategyId: value.strategyId,
      strategyVersion: value.strategyVersion,
      symbol: value.symbol,
      interval: value.interval,
      replayOfRunId: value.replayOfRunId,
      artifactDir: value.artifactDir,
      artifactHash: value.artifactHash,
      inputHash: value.inputHash,
      outputHash: value.outputHash,
      eventsHash: value.eventsHash,
      summary: value.summary,
      error: value.error,
      metadata: value.metadata,
    }
  } catch {
    return null
  }
}

async function writeCanonicalWithHash(path: string, content: string, hash: string): Promise<void> {
  await writeFile(path, content, 'utf-8')
  await writeFile(`${path}.sha256`, `${hash}  ${path.split('/').pop()}\n`, 'utf-8')
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T
}

async function readJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf-8')
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

async function readHash(path: string): Promise<string> {
  const raw = await readFile(path, 'utf-8')
  return raw.trim().split(/\s+/)[0]
}

function sha256(content: string): string {
  return sha256Hex(Buffer.from(content, 'utf-8'))
}

function datePath(iso: string): string {
  return iso.slice(0, 10)
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 100
  return Math.max(1, Math.min(500, Math.trunc(limit)))
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
