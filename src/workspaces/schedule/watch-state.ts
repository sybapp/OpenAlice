/**
 * Watch runtime store — the scanner's OWN per-armed-condition state:
 * `(wsId, issueId) -> WatchRuntimeState`. Mirrors `ScheduleMarkerStore`
 * (versioned JSON, atomic tmp->rename, co-located under the launcher
 * `state/` dir), but holds judgement cursors rather than dispatch cursors:
 * which watch version was last checked / triggered, which signal ids were
 * consumed by the latch, and the last evidence for display.
 *
 * The Issue file owns the plan (`watch`, bumped by the harness on re-arm).
 * This store owns only the checker's memory of what it already did, so a
 * restart reconciles without double-dispatch and a removed Issue's state is
 * pruned like its schedule marker.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Logger } from '../logger.js'

const SEP = ' '
const composite = (wsId: string, issueId: string): string => `${wsId}${SEP}${issueId}`

export type WatchCheckStatus = 'hit' | 'miss' | 'unavailable'

/** The checker's memory of one armed condition. `watchVersion` is the `watch`
 * frontmatter version this state belongs to; a version bump (re-arm) resets
 * the latch, which is how "one arming triggers at most once" is enforced. */
export interface WatchRuntimeState {
  /** Watch version last checked (mirrors `watch.version` in the file). */
  watchVersion: number
  /** Every check advances this — waiting is visible, not a failure. */
  lastCheckedAt: number
  /** Only a hit-dispatch advances this — dispatch cadence is separate. */
  lastTriggeredAt?: number
  /** Result of the latest check (`miss` also records, for the board). */
  lastStatus?: WatchCheckStatus
  /** Human/machine reason for the latest `unavailable` (or check failure). */
  lastReason?: string
  /** Compact evidence of the latest check (actuals, data window). */
  lastEvidence?: Record<string, unknown>
  /** Signal ids consumed by the latch — a sustained hit reuses these and
   * must not dispatch again until the version bumps or new ids appear. */
  consumedSignalIds?: string[]
  /** Latest dispatch this state produced (traceability). */
  lastRunId?: string
}

export class WatchRuntimeStore {
  private readonly records = new Map<string, WatchRuntimeState>()

  private constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {}

  static async load(path: string, logger: Logger): Promise<WatchRuntimeStore> {
    const store = new WatchRuntimeStore(path, logger)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { states?: Record<string, unknown> }
      if (parsed.states) {
        for (const [key, value] of Object.entries(parsed.states)) {
          const record = decodeState(value)
          if (record) store.records.set(key, record)
        }
      }
    } catch {
      // missing or corrupt -> start clean
    }
    return store
  }

  /** Stable composite key — also used to build the "seen this scan" set. */
  key(wsId: string, issueId: string): string {
    return composite(wsId, issueId)
  }

  get(wsId: string, issueId: string): WatchRuntimeState | undefined {
    return this.records.get(composite(wsId, issueId))
  }

  async set(wsId: string, issueId: string, state: WatchRuntimeState): Promise<void> {
    this.records.set(composite(wsId, issueId), state)
    await this.flush()
  }

  /** Drop states whose key wasn't seen this scan — bounds growth. */
  async prune(seenKeys: Set<string>): Promise<void> {
    let changed = false
    for (const key of [...this.records.keys()]) {
      if (!seenKeys.has(key)) {
        this.records.delete(key)
        changed = true
      }
    }
    if (changed) await this.flush()
  }

  private async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const states: Record<string, WatchRuntimeState> = {}
      for (const [key, value] of this.records) states[key] = value
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, states }, null, 2), 'utf8')
      await rename(tmp, this.path)
    } catch (err) {
      this.logger.warn('watch_state.flush_failed', { err })
    }
  }
}

function decodeState(value: unknown): WatchRuntimeState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row['watchVersion'] !== 'number' || !Number.isInteger(row['watchVersion'])) return null
  if (typeof row['lastCheckedAt'] !== 'number' || !Number.isFinite(row['lastCheckedAt'])) return null
  const next: WatchRuntimeState = {
    watchVersion: row['watchVersion'] as number,
    lastCheckedAt: row['lastCheckedAt'] as number,
  }
  if (typeof row['lastTriggeredAt'] === 'number' && Number.isFinite(row['lastTriggeredAt'])) {
    next.lastTriggeredAt = row['lastTriggeredAt'] as number
  }
  if (row['lastStatus'] === 'hit' || row['lastStatus'] === 'miss' || row['lastStatus'] === 'unavailable') {
    next.lastStatus = row['lastStatus']
  }
  if (typeof row['lastReason'] === 'string') next.lastReason = row['lastReason'] as string
  if (row['lastEvidence'] && typeof row['lastEvidence'] === 'object' && !Array.isArray(row['lastEvidence'])) {
    next.lastEvidence = row['lastEvidence'] as Record<string, unknown>
  }
  if (Array.isArray(row['consumedSignalIds']) && row['consumedSignalIds'].every((id) => typeof id === 'string')) {
    next.consumedSignalIds = [...(row['consumedSignalIds'] as string[])]
  }
  if (typeof row['lastRunId'] === 'string') next.lastRunId = row['lastRunId'] as string
  return next
}
