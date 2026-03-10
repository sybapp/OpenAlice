import { createInterface } from 'node:readline'
import { mkdir, open, readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { GitExportState } from '../git/types.js'
import type {
  BacktestStorage,
  BacktestRunManifest,
  BacktestRunSummary,
  BacktestEquityPoint,
} from './types.js'

export interface BacktestStorageOptions {
  rootDir?: string
}

const BACKTEST_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const RUN_INDEX_FILENAME = 'runs-index.json'

export function normalizeBacktestRunId(runId: string): string {
  if (typeof runId !== 'string') {
    throw new Error('Invalid backtest runId: expected string')
  }

  const normalized = runId.trim()
  if (!normalized) {
    throw new Error('Invalid backtest runId: empty value')
  }
  if (!BACKTEST_RUN_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid backtest runId: use only letters, numbers, underscores, and hyphens (max 64 chars)')
  }
  if (normalized === '..' || normalized.includes('..')) {
    throw new Error('Invalid backtest runId: path traversal is not allowed')
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('Invalid backtest runId: path separators are not allowed')
  }
  if (resolve(normalized) === normalized) {
    throw new Error('Invalid backtest runId: absolute paths are not allowed')
  }

  return normalized
}

export function createBacktestStorage(options?: BacktestStorageOptions): BacktestStorage {
  const rootDir = resolve(options?.rootDir ?? 'data/backtest')
  const runIndexPath = resolve(rootDir, RUN_INDEX_FILENAME)
  let runIndexWriteQueue: Promise<void> = Promise.resolve()

  function getRunPaths(runId: string) {
    const safeRunId = normalizeBacktestRunId(runId)
    const runDir = resolve(rootDir, safeRunId)
    assertWithinRoot(rootDir, runDir)
    return {
      runDir,
      manifestPath: resolve(runDir, 'manifest.json'),
      summaryPath: resolve(runDir, 'summary.json'),
      equityCurvePath: resolve(runDir, 'equity-curve.jsonl'),
      eventLogPath: resolve(runDir, 'events.jsonl'),
      gitStatePath: resolve(runDir, 'git-state.json'),
    }
  }

  async function ensureRunDir(runId: string): Promise<void> {
    await mkdir(getRunPaths(runId).runDir, { recursive: true })
  }

  async function updateRunIndex(manifest: BacktestRunManifest): Promise<void> {
    const next = runIndexWriteQueue.then(async () => {
      const current = await readRunIndex(rootDir, runIndexPath)
      const next = current.filter((entry) => entry.runId !== manifest.runId)
      next.push(manifest)
      await writeJson(runIndexPath, sortRunManifests(next))
    })
    runIndexWriteQueue = next.catch(() => {})
    return next
  }

  async function queueManifestCreate(manifest: BacktestRunManifest): Promise<void> {
    const paths = getRunPaths(manifest.runId)
    await mkdir(paths.runDir, { recursive: true })
    await writeJson(paths.manifestPath, manifest)
    await updateRunIndex(manifest)
  }

  async function queueManifestUpdate(runId: string, patch: Partial<BacktestRunManifest>): Promise<BacktestRunManifest> {
    const current = await readJson<BacktestRunManifest>(getRunPaths(runId).manifestPath)
    if (!current) throw new Error(`Backtest run not found: ${runId}`)
    const next = { ...current, ...patch }
    await writeJson(getRunPaths(runId).manifestPath, next)
    await updateRunIndex(next)
    return next
  }

  return {
    async createRun(manifest) {
      await queueManifestCreate(manifest)
    },

    async updateManifest(runId, patch) {
      return queueManifestUpdate(runId, patch)
    },

    async getManifest(runId) {
      return readJson<BacktestRunManifest>(getRunPaths(runId).manifestPath)
    },

    async listRuns() {
      await runIndexWriteQueue
      return readRunIndex(rootDir, runIndexPath)
    },

    async writeSummary(runId, summary) {
      await ensureRunDir(runId)
      await writeJson(getRunPaths(runId).summaryPath, summary)
    },

    async readSummary(runId) {
      return readJson<BacktestRunSummary>(getRunPaths(runId).summaryPath)
    },

    async appendEquityPoint(runId, point) {
      await ensureRunDir(runId)
      await appendJsonLine(getRunPaths(runId).equityCurvePath, point)
    },

    async readEquityCurve(runId, opts) {
      const limit = opts?.limit
      if (!limit || limit <= 0) {
        return readJsonLines<BacktestEquityPoint>(getRunPaths(runId).equityCurvePath)
      }

      const points: BacktestEquityPoint[] = []
      await streamJsonLines<BacktestEquityPoint>(getRunPaths(runId).equityCurvePath, (point) => {
        points.push(point)
        if (points.length > limit) points.shift()
      })

      return points
    },

    async writeGitState(runId, state) {
      await ensureRunDir(runId)
      await writeJson(getRunPaths(runId).gitStatePath, state)
    },

    async readGitState(runId) {
      return readJson<GitExportState>(getRunPaths(runId).gitStatePath)
    },

    async readEventEntries(runId, opts) {
      const afterSeq = opts?.afterSeq ?? 0
      const type = opts?.type
      const limit = opts?.limit
      const filtered: Array<{ seq: number; ts: number; type: string; payload: unknown }> = []

      await streamJsonLines<{ seq: number; ts: number; type: string; payload: unknown }>(getRunPaths(runId).eventLogPath, (entry) => {
        if (entry.seq <= afterSeq) return
        if (type && entry.type !== type) return
        filtered.push(entry)
        if (limit && limit > 0 && filtered.length >= limit) return false
      })

      return filtered
    },

    async readSessionEntries(runId) {
      const manifest = await this.getManifest(runId)
      if (!manifest?.sessionId) return []
      const sessionPath = resolve(process.cwd(), 'data', 'sessions', `${manifest.sessionId}.jsonl`)
      return readJsonLines(sessionPath)
    },

    getRunPaths,
  }
}

function assertWithinRoot(rootDir: string, targetPath: string): void {
  const root = resolve(rootDir)
  const target = resolve(targetPath)
  const rel = relative(root, target)
  if (rel === '' || rel === '.') return
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) {
    throw new Error('Invalid backtest runId: resolved path escapes backtest root')
  }
}

async function readAllRunManifests(rootDir: string): Promise<BacktestRunManifest[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    const dirs = await readdir(rootDir, { withFileTypes: true })
    const manifests = await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<BacktestRunManifest>(resolve(rootDir, entry.name, 'manifest.json'))),
    )
    return sortRunManifests(manifests.filter((entry): entry is BacktestRunManifest => entry !== null))
  } catch {
    return []
  }
}

async function readRunIndex(rootDir: string, runIndexPath: string): Promise<BacktestRunManifest[]> {
  const indexed = await readJson<BacktestRunManifest[]>(runIndexPath)
  if (indexed) return sortRunManifests(indexed)

  const rebuilt = await readAllRunManifests(rootDir)
  if (rebuilt.length > 0) {
    await writeJson(runIndexPath, rebuilt)
  }
  return rebuilt
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(value) + '\n', 'utf-8')
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err: unknown) {
    if (isENOENT(err)) return null
    throw err
  }
}

async function readJsonLines<T = unknown>(filePath: string): Promise<T[]> {
  const entries: T[] = []
  await streamJsonLines<T>(filePath, (entry) => {
    entries.push(entry)
  })
  return entries
}

async function streamJsonLines<T = unknown>(
  filePath: string,
  onEntry: (entry: T) => boolean | void,
): Promise<void> {
  try {
    const fileHandle = await open(filePath, 'r')
    const stream = fileHandle.createReadStream({ encoding: 'utf-8', autoClose: false })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })

    try {
      for await (const line of reader) {
        if (!line.trim()) continue
        if (onEntry(JSON.parse(line) as T) === false) break
      }
    } finally {
      reader.close()
      stream.destroy()
      await fileHandle.close()
    }
  } catch (err: unknown) {
    if (isENOENT(err)) return
    throw err
  }
}

function sortRunManifests(entries: BacktestRunManifest[]): BacktestRunManifest[] {
  return [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
