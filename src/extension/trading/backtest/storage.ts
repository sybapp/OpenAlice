import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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

export function createBacktestStorage(options?: BacktestStorageOptions): BacktestStorage {
  const rootDir = resolve(options?.rootDir ?? 'data/backtest')

  function getRunPaths(runId: string) {
    const runDir = resolve(rootDir, runId)
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

  return {
    async createRun(manifest) {
      const paths = getRunPaths(manifest.runId)
      await mkdir(paths.runDir, { recursive: true })
      await writeJson(paths.manifestPath, manifest)
    },

    async updateManifest(runId, patch) {
      const current = await this.getManifest(runId)
      if (!current) throw new Error(`Backtest run not found: ${runId}`)
      const next = { ...current, ...patch }
      await writeJson(getRunPaths(runId).manifestPath, next)
      return next
    },

    async getManifest(runId) {
      return readJson<BacktestRunManifest>(getRunPaths(runId).manifestPath)
    },

    async listRuns() {
      const entries = await readAllRunManifests(rootDir)
      return entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
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
      const points = await readJsonLines<BacktestEquityPoint>(getRunPaths(runId).equityCurvePath)
      const limit = opts?.limit
      return limit && limit > 0 ? points.slice(-limit) : points
    },

    async writeGitState(runId, state) {
      await ensureRunDir(runId)
      await writeJson(getRunPaths(runId).gitStatePath, state)
    },

    async readGitState(runId) {
      return readJson<GitExportState>(getRunPaths(runId).gitStatePath)
    },

    async readEventEntries(runId, opts) {
      const entries = await readJsonLines<{ seq: number; ts: number; type: string; payload: unknown }>(getRunPaths(runId).eventLogPath)
      const afterSeq = opts?.afterSeq ?? 0
      const type = opts?.type
      const limit = opts?.limit
      const filtered = entries.filter((entry) => entry.seq > afterSeq && (!type || entry.type === type))
      return limit && limit > 0 ? filtered.slice(0, limit) : filtered
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

async function readAllRunManifests(rootDir: string): Promise<BacktestRunManifest[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    const dirs = await readdir(rootDir, { withFileTypes: true })
    const manifests = await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<BacktestRunManifest>(resolve(rootDir, entry.name, 'manifest.json'))),
    )
    return manifests.filter((entry): entry is BacktestRunManifest => entry !== null)
  } catch {
    return []
  }
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
  try {
    const raw = await readFile(filePath, 'utf-8')
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T)
  } catch (err: unknown) {
    if (isENOENT(err)) return []
    throw err
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
