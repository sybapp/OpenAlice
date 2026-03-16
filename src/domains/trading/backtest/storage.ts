import { mkdir, open, readFile, writeFile, appendFile, unlink, rename, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { RUNTIME_SESSIONS_DIR } from '../../../core/paths.js'
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
const INVALID_RUN_CLAIM_STALE_MS = 5_000

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
  const rootDir = resolve(options?.rootDir ?? 'runtime/backtest')
  const runIndexPath = resolve(rootDir, RUN_INDEX_FILENAME)
  let runIndexWriteQueue: Promise<void> = Promise.resolve()
  const runClaims = new Map<string, FileHandle>()

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
      claimPath: resolve(runDir, '.run.lock'),
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
    const existing = await readJson<BacktestRunManifest>(paths.manifestPath)
    const timestamp = `${process.pid}.${Date.now()}`
    const backups = await backupExistingRunArtifacts(paths, existing, timestamp)

    try {
      await writeJson(paths.manifestPath, manifest)
      await updateRunIndex(manifest)
      await discardBackups(backups)
    } catch (err) {
      await restoreBackups(backups)
      throw err
    }
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
    async claimRunId(runId) {
      const paths = getRunPaths(runId)
      const safeRunId = normalizeBacktestRunId(runId)
      if (runClaims.has(safeRunId)) {
        throw new Error(`Backtest run already in progress: ${safeRunId}`)
      }

      await mkdir(paths.runDir, { recursive: true })
      const metadata = JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }) + '\n'
      const handle = await acquireRunClaim(paths.claimPath, metadata, safeRunId)
      runClaims.set(safeRunId, handle)
    },

    async releaseRunId(runId) {
      const safeRunId = normalizeBacktestRunId(runId)
      const handle = runClaims.get(safeRunId)
      runClaims.delete(safeRunId)
      if (!handle) return

      const { claimPath } = getRunPaths(safeRunId)
      await handle.close().catch(() => {})
      await unlink(claimPath).catch(ignoreENOENT)
    },

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
        if (limit && limit > 0 && afterSeq > 0 && filtered.length >= limit) return false
        if (limit && limit > 0 && afterSeq <= 0 && filtered.length > limit) filtered.shift()
      })

      return filtered
    },

    async readSessionEntries(runId) {
      const manifest = await this.getManifest(runId)
      if (!manifest?.sessionId) return []
      const sessionPath = resolve(RUNTIME_SESSIONS_DIR, `${manifest.sessionId}.jsonl`)
      return readJsonLines(sessionPath)
    },

    getRunPaths,
  }
}

function getSessionPath(sessionId: string): string {
  const sessionPath = resolve(RUNTIME_SESSIONS_DIR, `${sessionId}.jsonl`)
  assertWithinRoot(RUNTIME_SESSIONS_DIR, sessionPath)
  return sessionPath
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
  let indexed: BacktestRunManifest[] | null = null
  try {
    indexed = await readJson<BacktestRunManifest[]>(runIndexPath)
  } catch (err) {
    console.warn(`backtest-storage: failed to read run index, rebuilding from manifests: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (indexed) return sortRunManifests(indexed)

  const rebuilt = await readAllRunManifests(rootDir)
  if (rebuilt.length > 0) {
    await writeJson(runIndexPath, rebuilt)
  }
  return rebuilt
}

async function backupExistingRunArtifacts(
  paths: ReturnType<BacktestStorage['getRunPaths']>,
  existingManifest: BacktestRunManifest | null,
  stamp: string,
): Promise<Array<{ path: string; backupPath: string }>> {
  const candidates = [
    paths.manifestPath,
    paths.equityCurvePath,
    paths.eventLogPath,
    paths.summaryPath,
    paths.gitStatePath,
  ]

  if (existingManifest?.sessionId) {
    candidates.push(getSessionPath(existingManifest.sessionId))
  }

  const backups: Array<{ path: string; backupPath: string }> = []
  for (const filePath of candidates) {
    const backupPath = `${filePath}.${stamp}.bak`
    try {
      await rename(filePath, backupPath)
      backups.push({ path: filePath, backupPath })
    } catch (err) {
      if (!isENOENT(err)) {
        await restoreBackups(backups)
        throw err
      }
    }
  }

  return backups
}

async function restoreBackups(backups: Array<{ path: string; backupPath: string }>): Promise<void> {
  const restoreErrors: unknown[] = []

  for (const { path, backupPath } of [...backups].reverse()) {
    await unlink(path).catch(ignoreENOENT)
    try {
      await rename(backupPath, path)
    } catch (err) {
      if (!isENOENT(err)) restoreErrors.push(err)
    }
  }

  if (restoreErrors.length > 0) throw restoreErrors[0]
}

async function discardBackups(backups: Array<{ path: string; backupPath: string }>): Promise<void> {
  await Promise.all(backups.map(async ({ backupPath }) => {
    await unlink(backupPath).catch(ignoreENOENT)
  }))
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf-8')
    await rename(tempPath, filePath)
  } catch (err) {
    await unlink(tempPath).catch(ignoreENOENT)
    throw err
  }
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
    let remainder = ''

    try {
      for await (const chunk of stream) {
        remainder += chunk
        const lines = remainder.split('\n')
        remainder = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          if (onEntry(JSON.parse(line) as T) === false) return
        }
      }

      if (remainder.trim()) {
        try {
          if (onEntry(JSON.parse(remainder) as T) === false) return
        } catch (err) {
          if (!isRecoverableJsonLineTailError(err, remainder)) throw err
        }
      }
    } finally {
      stream.destroy()
      await fileHandle.close()
    }
  } catch (err: unknown) {
    if (isENOENT(err)) return
    throw err
  }
}

async function acquireRunClaim(claimPath: string, metadata: string, runId: string): Promise<FileHandle> {
  try {
    const handle = await open(claimPath, 'wx')
    await handle.writeFile(metadata, 'utf-8')
    return handle
  } catch (err) {
    if (!isEEXIST(err)) throw err

    const staleClaim = await readClaimMetadata(claimPath)
    if (staleClaim?.pid && !isProcessAlive(staleClaim.pid)) {
      await unlink(claimPath).catch(ignoreENOENT)
      const handle = await open(claimPath, 'wx')
      await handle.writeFile(metadata, 'utf-8')
      return handle
    }

    if (!staleClaim && await isInvalidClaimStale(claimPath)) {
      await unlink(claimPath).catch(ignoreENOENT)
      const handle = await open(claimPath, 'wx')
      await handle.writeFile(metadata, 'utf-8')
      return handle
    }

    throw new Error(`Backtest run already in progress: ${runId}`)
  }
}

async function readClaimMetadata(claimPath: string): Promise<{ pid?: number } | null> {
  const raw = await readFile(claimPath, 'utf-8').catch((err: unknown) => {
    if (isENOENT(err)) return null
    throw err
  })
  if (!raw) return null

  try {
    return JSON.parse(raw) as { pid?: number }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ESRCH')
  }
}

async function isInvalidClaimStale(claimPath: string): Promise<boolean> {
  try {
    const info = await stat(claimPath)
    return Date.now() - info.mtimeMs >= INVALID_RUN_CLAIM_STALE_MS
  } catch (err) {
    if (isENOENT(err)) return false
    throw err
  }
}

function isRecoverableJsonLineTailError(err: unknown, line: string): boolean {
  return err instanceof SyntaxError && line.trim().length > 0
}

function sortRunManifests(entries: BacktestRunManifest[]): BacktestRunManifest[] {
  return [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function isEEXIST(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST'
}

function ignoreENOENT(err: unknown): void {
  if (!isENOENT(err)) throw err
}
