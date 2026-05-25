import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  MarketDataAlertFeedback,
  MarketDataAlertFeedbackRating,
  MarketDataAlertRunRecord,
} from './types.js'

export const DEFAULT_MARKET_DATA_ALERT_RUNS_PATH = 'data/cache/market-data-alerts/runs.jsonl'
export const DEFAULT_MARKET_DATA_ALERT_FEEDBACK_PATH = 'data/cache/market-data-alerts/feedback.json'

let defaultRunsPath = DEFAULT_MARKET_DATA_ALERT_RUNS_PATH
let defaultFeedbackPath = DEFAULT_MARKET_DATA_ALERT_FEEDBACK_PATH

export interface ListMarketDataAlertRunsOptions {
  runsPath?: string
  feedbackPath?: string
  limit?: number
  asset?: string
  symbol?: string
  interval?: string
  status?: string
}

export interface RecordMarketDataAlertFeedbackInput {
  runsPath?: string
  feedbackPath?: string
  runId: string
  rating: MarketDataAlertFeedbackRating
  note?: string
  now?: () => Date
}

type FeedbackMap = Record<string, MarketDataAlertFeedback>

export class MarketDataAlertRunStore {
  constructor(
    private readonly runsPath = defaultRunsPath,
    private readonly feedbackPath = defaultFeedbackPath,
  ) {}

  async append(records: Array<Omit<MarketDataAlertRunRecord, 'runId'> & { runId?: string }>): Promise<MarketDataAlertRunRecord[]> {
    if (records.length === 0) return []
    await mkdir(dirname(this.runsPath), { recursive: true })
    const normalized = records.map((record) => ({
      ...record,
      runId: record.runId ?? randomUUID(),
    }))
    await appendFile(this.runsPath, normalized.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8')
    return normalized
  }

  async list(options: Omit<ListMarketDataAlertRunsOptions, 'runsPath' | 'feedbackPath'> = {}) {
    const limit = clampLimit(options.limit)
    const [records, feedback] = await Promise.all([this.readRecords(), readFeedback(this.feedbackPath)])
    const filtered = records
      .filter((record) => !options.asset || record.asset === options.asset)
      .filter((record) => !options.symbol || record.symbol?.toUpperCase() === options.symbol.toUpperCase())
      .filter((record) => !options.interval || record.interval === options.interval)
      .filter((record) => !options.status || record.status === options.status)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((record) => ({ ...record, ...(feedback[record.runId] ? { feedback: feedback[record.runId] } : {}) }))

    return {
      count: filtered.length,
      entries: filtered,
    }
  }

  async recordFeedback(input: Omit<RecordMarketDataAlertFeedbackInput, 'runsPath' | 'feedbackPath'>) {
    const exists = (await this.readRecords()).some((record) => record.runId === input.runId)
    if (!exists) {
      return { ok: false, error: `Unknown alert run: ${input.runId}` }
    }

    const feedback = await readFeedback(this.feedbackPath)
    const entry: MarketDataAlertFeedback = {
      rating: input.rating,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      updatedAt: (input.now?.() ?? new Date()).toISOString(),
    }
    feedback[input.runId] = entry
    await writeFeedback(this.feedbackPath, feedback)
    return { ok: true, runId: input.runId, feedback: entry }
  }

  private async readRecords(): Promise<MarketDataAlertRunRecord[]> {
    try {
      const raw = await readFile(this.runsPath, 'utf-8')
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseRunRecord(line))
        .filter((record): record is MarketDataAlertRunRecord => record !== null)
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
  }
}

export async function listMarketDataAlertRuns(options: ListMarketDataAlertRunsOptions = {}) {
  return await new MarketDataAlertRunStore(options.runsPath, options.feedbackPath).list(options)
}

export async function recordMarketDataAlertFeedback(input: RecordMarketDataAlertFeedbackInput) {
  return await new MarketDataAlertRunStore(input.runsPath, input.feedbackPath).recordFeedback(input)
}

export function setMarketDataAlertRunStoreDefaults(paths: { runsPath?: string; feedbackPath?: string }): void {
  defaultRunsPath = paths.runsPath ?? DEFAULT_MARKET_DATA_ALERT_RUNS_PATH
  defaultFeedbackPath = paths.feedbackPath ?? DEFAULT_MARKET_DATA_ALERT_FEEDBACK_PATH
}

function parseRunRecord(line: string): MarketDataAlertRunRecord | null {
  try {
    const value = JSON.parse(line) as Partial<MarketDataAlertRunRecord>
    if (!value.runId || !value.startedAt || !value.finishedAt || !value.status) return null
    return {
      runId: value.runId,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      asset: value.asset,
      symbol: value.symbol,
      interval: value.interval,
      provider: value.provider,
      mode: value.mode,
      status: value.status,
      skipped: value.skipped,
      reason: value.reason,
      latestClose: value.latestClose,
      signals: Array.isArray(value.signals) ? value.signals : [],
      notified: Boolean(value.notified),
      taskRequested: Boolean(value.taskRequested),
      workspaceExecution: normalizeWorkspaceExecution(value.workspaceExecution),
      error: value.error,
      summary: value.summary ?? '',
    }
  } catch {
    return null
  }
}

function normalizeWorkspaceExecution(value: unknown): MarketDataAlertRunRecord['workspaceExecution'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  return {
    ok: raw['ok'] === true,
    ...(typeof raw['skipped'] === 'boolean' ? { skipped: raw['skipped'] } : {}),
    ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
    ...(typeof raw['workspaceId'] === 'string' ? { workspaceId: raw['workspaceId'] } : {}),
    ...(typeof raw['agent'] === 'string' ? { agent: raw['agent'] } : {}),
  }
}

async function readFeedback(path: string): Promise<FeedbackMap> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as FeedbackMap : {}
  } catch (error) {
    if (isENOENT(error)) return {}
    throw error
  }
}

async function writeFeedback(path: string, feedback: FeedbackMap): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(feedback, null, 2) + '\n', 'utf-8')
  await rename(tmp, path)
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 100
  return Math.max(1, Math.min(500, Math.trunc(limit)))
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
