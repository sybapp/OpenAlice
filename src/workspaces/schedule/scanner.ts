/**
 * ScheduleScanner - the dumb external scheduler for workspace self-declared
 * issues. Each tick it enumerates every workspace, reads that workspace's own
 * `.alice/issues/<id>.md` files live, and for every SCHEDULED + due issue (one
 * that carries a `when`) fires a headless run via the workspace's automation
 * interface. Issues without a `when` are pure board work items and are ignored
 * here. It interprets NOTHING about the work - the fire prompt (`what`, else
 * title+body) is handed straight to `dispatchHeadlessTask`.
 *
 * The ~1-min tick is the scheduler's OWN control loop (a plain timer), NOT a
 * scheduled task - infrastructure periodicity never enters the self-description
 * system. There is deliberately NO per-workspace lock: if a fire collides with a
 * still-running run or a live interactive session in the same checkout, the
 * coding agent absorbs it (it lives in multi-AI-on-one-repo all day). The only
 * bound is the global headless concurrency cap inside `dispatch`.
 *
 * Due-ness carries no external schedule state (see `fireBase`): from the last
 * fire, or a never-fired baseline — `every`/`at` from epoch (fire on first
 * sight), `cron` from `now - interval` (catches an occurrence that just passed,
 * without firing immediately on creation OR never firing at all — seeding cron
 * from `now` makes `computeNextRun` always strictly future, i.e. never due).
 * Then `computeNextRun(when, base) <= now`. The last-fired marker is written
 * only AFTER a successful dispatch. Admission skips (`busy`, capacity) leave
 * `every` due; cron defaults to the same catch-up, or consumes the slot when
 * `catchUp: false`.
 */

import { computeNextRun, scheduleCatchesUp, type Schedule } from '../../core/schedule-expr.js'
import type { CliAdapter } from '../cli-adapter.js'
import type { SessionRuntimeSelection } from '../session-runtime-binding.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'
import type { HeadlessTaskInquiry, HeadlessTaskTrigger } from '../headless-task-registry.js'
import type { SessionCreatedBy } from '../session-metadata.js'

import {
  isFireable,
  isConnectorDeskIssue,
  issueAssigneeClaimsFirstSession,
  issueAssigneeResumeId,
  issueFirePrompt,
  issueTimeoutMs,
  readWorkspaceIssues,
  type IssueRecord,
} from '../issues/declaration.js'
import {
  extraConnectorDeskKeys,
  findConnectorDesks,
} from '../issues/connector-desk.js'

import type { WatchCheckVerdict } from '../../domain/analysis/technical-analysis/watch/check.js'
import { issueWatchVerdictBlock, isWatchedIssue } from '../issues/declaration.js'
import type { IssueWatch } from '../../domain/analysis/technical-analysis/watch/spec.js'
import {
  fireBase,
  snapshotScheduledIssue,
  type ScheduleSnapshot,
  type ScheduleSnapshotTask,
  type ScheduleSnapshotWorkspace,
} from './declaration.js'
import type { WatchRuntimeState } from './watch-state.js'

export const DEFAULT_INTERVAL_MS = 60_000

export type ScheduledIssueRunNowErrorCode =
  | 'not_found'
  | 'not_scheduled'
  | 'not_retryable'
  | 'not_fireable'
  | 'already_running'

/** Stable domain error for the manual retry path. The scheduler's automatic
 * path still catches and logs dispatch failures without advancing its marker. */
export class ScheduledIssueRunNowError extends Error {
  constructor(
    public readonly code: ScheduledIssueRunNowErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ScheduledIssueRunNowError'
  }
}

/** One deterministic watch judgement, keyed for per-tick sharing. The
 * fetcher is injected so tests (and the scanner's per-tick cache) supply
 * the verdict without touching the network. */
export interface WatchChecker {
  check(watch: IssueWatch, nowMs: number): Promise<WatchCheckVerdict>
}

/** The slice of WatchRuntimeStore the scanner needs (structural, for testing). */
export interface WatchStateStore {
  key(wsId: string, issueId: string): string
  get(wsId: string, issueId: string): WatchRuntimeState | undefined
  set(wsId: string, issueId: string, state: WatchRuntimeState): Promise<void>
  prune(seenKeys: Set<string>): Promise<void>
}

/** The slice of ScheduleMarkerStore the scanner needs (structural, for testing). */
export interface MarkerStore {
  key(wsId: string, taskId: string): string
  get(wsId: string, taskId: string): number | undefined
  getHeld(wsId: string, taskId: string): number | undefined
  set(wsId: string, taskId: string, ts: number): Promise<void>
  hold(wsId: string, taskId: string, ts: number): Promise<void>
  prune(seenKeys: Set<string>): Promise<void>
}

export interface ScheduleScannerDeps {
  registry: WorkspaceRegistry
  /** Resolve the execution Workspace for an exact signed Session owner. */
  resolveResumeWorkspace?: (resumeId: string) => WorkspaceMeta | undefined
  canRetryIssueRun?: (wsId: string, issueId: string, runId: string) => boolean
  isIssueRunning?: (wsId: string, issueId: string) => boolean
  resolveAdapter: (meta: WorkspaceMeta, agentId?: string, resumeId?: string) => CliAdapter | Promise<CliAdapter>
  dispatch: (
    meta: WorkspaceMeta,
    adapter: CliAdapter,
    prompt: string,
    timeoutMs?: number,
    /** Composite source of the dispatch. Execution may happen elsewhere. */
    trigger?: HeadlessTaskTrigger,
    /** Product Session to continue. Omitted means allocate a fresh Session. */
    resumeId?: string,
    /** Optional reverse-link metadata; scheduler leaves this absent. */
    inquiry?: HeadlessTaskInquiry,
    /** Fresh-Session credential/model/effort selection inherited from Issue frontmatter. */
    selection?: SessionRuntimeSelection,
    conversation?: undefined,
    /** Birth stamp when this fire allocates a new product Session. */
    createdBy?: SessionCreatedBy,
  ) => Promise<{ taskId: string; resumeId: string }>
  /** Persist @new-then-resume -> exact @resumeId after the first fresh dispatch. */
  claimFreshSession?: (input: {
    issueWorkspace: WorkspaceMeta
    issueId: string
    taskId: string
    resumeId: string
    agent: string
  }) => Promise<void>
  /** Observe direct Issue file edits during the scanner's normal live read. */
  observeIssues?: (workspace: WorkspaceMeta, issues: readonly IssueRecord[]) => Promise<void>
  /** Rewrite a just-dispatched run's stored prompt (verdict prepend). The
   * child has not spawned yet: dispatchIssue resolves only after the record
   * exists but the spawn happens in the background afterwards, and the whole
   * fire holds the per-issue dispatch lock. Optional so legacy tests keep
   * working without it. */
  rewritePrompt?: (taskId: string, prompt: string) => Promise<void>
  /** Deterministic watch checker (increment 2). Omitted ⇒ watch issues
   * behave as plain scheduled issues (checker not wired, e.g. unit tests
   * for the legacy path or a barService-less runtime). */
  watchChecker?: WatchChecker
  /** Watch latch/check memory. Required iff `watchChecker` is set. */
  watchStates?: WatchStateStore
  markers: MarkerStore
  logger: Logger
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable tick interval for tests. */
  intervalMs?: number
}

export class ScheduleScanner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private scanning = false
  /** Close the tiny manual-retry vs schedule-tick race for one Issue. This is
   * only a dispatch-start lock, not a per-Workspace execution lock. */
  private readonly dispatchingIssues = new Set<string>()
  /** Watch-state keys seen this scan — pruned alongside the fire markers.
   * Null until the first scanWorkspace call of a scan (reset per scan). */
  private watchSeen: Set<string> | null = null
  private watchKey(wsId: string, issueId: string): string {
    return this.deps.watchStates?.key(wsId, issueId) ?? `${wsId} ${issueId}`
  }
  /** Snapshot built as a side-effect of each scan; null until the first scan. */
  private lastSnapshot: ScheduleSnapshot | null = null
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(private readonly deps: ScheduleScannerDeps) {
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /** Begin ticking. First scan happens after one interval (never on construct). */
  start(): void {
    if (this.timer || this.stopped) return
    this.arm()
    this.deps.logger.info('schedule.scanner_started', { intervalMs: this.intervalMs })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The snapshot built by the last scan (warm cache for GET /api/schedule), or
   *  null before the first tick. The scanner already reads every declaration each
   *  tick, so this is free — the route serves it instead of re-walking disk. */
  snapshot(): ScheduleSnapshot | null {
    return this.lastSnapshot
  }

  /** Dispatch one scheduled Issue immediately without touching its firing
   * marker. This is the authoritative manual-run / retry path: it re-reads the
   * live Issue and reuses the exact prompt, owner, runtime, and optional timeout used by
   * the scanner, while preserving the next scheduled occurrence. */
  async runIssueNow(wsId: string, issueId: string, retryOfTaskId?: string): Promise<{ taskId: string }> {
    const ws = this.deps.registry.get(wsId)
    if (!ws) throw new ScheduledIssueRunNowError('not_found', 'Workspace not found.')

    const res = await readWorkspaceIssues(ws.dir)
    if (!res.ok) throw new ScheduledIssueRunNowError('not_found', 'Issue not found.')
    const issue = res.issues.find((candidate) => candidate.id === issueId)
    if (!issue) throw new ScheduledIssueRunNowError('not_found', 'Issue not found.')
    if (!issue.when) {
      throw new ScheduledIssueRunNowError('not_scheduled', 'Only scheduled Issues can be run now.')
    }
    if (!isFireable(issue)) {
      throw new ScheduledIssueRunNowError(
        'not_fireable',
        `This Issue is ${issue.status}; reopen it before running.`,
      )
    }
    if (isConnectorDeskIssue(issue)) {
      const extras = extraConnectorDeskKeys(
        await findConnectorDesks(
          this.deps.registry.list().map((item) => ({ id: item.id, dir: item.dir })),
        ),
      )
      if (extras.has(`${ws.id}:${issue.id}`)) {
        throw new ScheduledIssueRunNowError(
          'not_fireable',
          `Only one ${issue.connectorDesk} phone-desk Issue may fire in this Alice Project.`,
        )
      }
    }

    const result = await this.dispatchIssue(
      ws,
      issue.id,
      issueFirePrompt(issue),
      issue.agent,
      issueRunOverrides(issue),
      issueAssigneeResumeId(issue.assignee) ?? undefined,
      issueAssigneeClaimsFirstSession(issue.assignee),
      issueTimeoutMs(issue.timeout),
      issue.connectorDesk,
      true,
      undefined,
      retryOfTaskId,
    )
    return { taskId: result.taskId }
  }

  /** Comments share the scheduler's dispatch/claim exclusion, without advancing its clock. */
  async runIssueComment(input: { workspaceId: string; issueId: string; prompt: string; commentId: string }): Promise<{ taskId: string; resumeId: string }> {
    const ws = this.deps.registry.get(input.workspaceId)
    if (!ws) throw new Error('Workspace not found.')
    return this.dispatchIssue(ws, input.issueId, input.prompt, undefined, undefined, undefined,
      false, undefined, undefined, true, input.commentId)
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tickAndRearm(), this.intervalMs)
    // Don't hold the event loop / a test runner open on the scheduler's timer.
    this.timer.unref?.()
  }

  private async tickAndRearm(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    try {
      await this.scan()
    } catch (err) {
      this.deps.logger.warn('schedule.scan_failed', { err })
    }
    if (!this.stopped) this.arm()
  }

  /** One full pass over all workspaces. Public for tests / a future "scan now". */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.deps.logger.info('schedule.scan_overlap_skipped', {})
      return
    }
    this.scanning = true
    const nowMs = this.now()
    const seen = new Set<string>()
    // Shared across workspaces in one scan: identical watches judge once.
    const watchVerdicts = new Map<string, Promise<WatchCheckVerdict>>()
    const watchSeen = new Set<string>()
    this.watchSeen = watchSeen
    try {
      // registry.list() order is preserved by Promise.all → stable display order.
      const extraDesks = extraConnectorDeskKeys(
        await findConnectorDesks(
          this.deps.registry.list().map((ws) => ({ id: ws.id, dir: ws.dir })),
        ),
      )
      const workspaces = await Promise.all(
        this.deps.registry.list().map((ws) => this.scanWorkspace(ws, nowMs, seen, extraDesks, watchVerdicts)),
      )
      await this.deps.markers.prune(seen)
      await this.deps.watchStates?.prune(watchSeen)
      this.lastSnapshot = { workspaces }
    } finally {
      this.scanning = false
      this.watchSeen = null
    }
  }

  /** Read one workspace's issues, fire its due SCHEDULED issues, and return its
   *  snapshot row (only scheduled issues — unscheduled board items never reach
   *  this layer). Reads issues ONCE — firing and the dashboard view come from the
   *  same read. Per-file-invalid issues isolate (they're surfaced to the board
   *  elsewhere); a workspace stays 'ok' as long as its issues dir read at all. */
  private async scanWorkspace(
    ws: WorkspaceMeta,
    nowMs: number,
    seen: Set<string>,
    extraDesks: ReadonlySet<string>,
    watchVerdicts: Map<string, Promise<WatchCheckVerdict>>,
  ): Promise<ScheduleSnapshotWorkspace> {
    let res
    try {
      res = await readWorkspaceIssues(ws.dir)
    } catch (err) {
      this.deps.logger.warn('schedule.read_failed', { wsId: ws.id, err })
      return { wsId: ws.id, tag: ws.tag, status: 'invalid', error: 'failed to read issues', tasks: [] }
    }
    if (!res.ok) {
      if (res.reason === 'invalid') {
        this.deps.logger.warn('schedule.declaration_invalid', { wsId: ws.id, error: res.error })
        return { wsId: ws.id, tag: ws.tag, status: 'invalid', error: res.error, tasks: [] }
      }
      return { wsId: ws.id, tag: ws.tag, status: 'absent', tasks: [] }
    }
    if (res.invalid.length > 0) {
      this.deps.logger.warn('schedule.issue_files_invalid', {
        wsId: ws.id,
        invalid: res.invalid.map((i) => i.id),
      })
    }
    await this.deps.observeIssues?.(ws, res.issues)

    const tasks: ScheduleSnapshotTask[] = []
    for (const issue of res.issues) {
      // No `when` ⇒ pure board work item; the scanner does not touch it.
      const when = issue.when
      if (!when) continue
      if (isConnectorDeskIssue(issue) && extraDesks.has(`${ws.id}:${issue.id}`)) continue
      seen.add(this.deps.markers.key(ws.id, issue.id))
      if (issue.watch) this.watchSeen?.add(this.watchKey(ws.id, issue.id))
      // Paused monitoring still records its key (prune-safe) but never
      // judges or dispatches. Plan and latch memory are preserved, so
      // resume continues the same arming — no re-fire of consumed hits.
      if (isFireable(issue) && this.isDue(ws.id, issue.id, when, nowMs)) {
        if (isWatchedIssue(issue) && issue.watchPaused) {
          await this.noteWatchPaused(ws, issue, nowMs)
        } else if (isWatchedIssue(issue) && this.deps.watchChecker && this.deps.watchStates) {
          await this.fireWatched(ws, issue, nowMs, watchVerdicts)
        } else {
          await this.fire(
            ws,
            issue.id,
            when,
            issueFirePrompt(issue),
            issue.agent,
            issueRunOverrides(issue),
            issueAssigneeResumeId(issue.assignee) ?? undefined,
            issueAssigneeClaimsFirstSession(issue.assignee),
            issueTimeoutMs(issue.timeout),
            issue.connectorDesk,
            nowMs,
          )
        }
      }
      // Read the marker AFTER any fire so last/next reflect a just-fired run.
      const last = this.deps.markers.get(ws.id, issue.id) ?? null
      const held = this.deps.markers.getHeld(ws.id, issue.id) ?? null
      const watchState = issue.watch ? (this.deps.watchStates?.get(ws.id, issue.id) ?? undefined) : undefined
      tasks.push(snapshotScheduledIssue(issue, when, last, nowMs, this.intervalMs, held, watchState))
    }
    return { wsId: ws.id, tag: ws.tag, status: 'ok', tasks }
  }

  private isDue(wsId: string, taskId: string, when: Schedule, nowMs: number): boolean {
    const last = this.deps.markers.get(wsId, taskId) ?? null
    const held = this.deps.markers.getHeld(wsId, taskId) ?? null
    const next = computeNextRun(when, fireBase(when, last, nowMs, this.intervalMs, held))
    return next !== null && next <= nowMs
  }

  private async fire(
    issueWorkspace: WorkspaceMeta,
    taskId: string,
    when: Schedule,
    what: string,
    agentId: string | undefined,
    selection: SessionRuntimeSelection | undefined,
    resumeId: string | undefined,
    claimFreshSession: boolean,
    timeoutMs: number | undefined,
    connectorDesk: string | undefined,
    nowMs: number,
  ): Promise<void> {
    try {
      const { taskId: runId } = await this.dispatchIssue(
        issueWorkspace,
        taskId,
        what,
        agentId,
        selection,
        resumeId,
        claimFreshSession,
        timeoutMs,
        connectorDesk,
      )
      await this.deps.markers.set(issueWorkspace.id, taskId, nowMs)
      this.deps.logger.info('schedule.fired', {
        wsId: issueWorkspace.id,
        taskId,
        runId,
        owner: resumeId ? 'session' : 'workspace',
        ...(resumeId ? { resumeId } : {}),
      })
    } catch (err) {
      // Capacity / busy: every stays due with no marker. Cron catch-up holds
      // the occurrence; calendar-only cron consumes it.
      await this.noteCronMiss(issueWorkspace.id, taskId, when, nowMs)
      this.deps.logger.info('schedule.fire_skipped', {
        wsId: issueWorkspace.id,
        taskId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Paused watch: advance the check clock so "last checked" stays truthful,
   * keep every latch field untouched, never judge, never dispatch. */
  private async noteWatchPaused(
    ws: WorkspaceMeta,
    issue: IssueRecord & { when: Schedule; watch: NonNullable<IssueRecord['watch']> },
    nowMs: number,
  ): Promise<void> {
    const states = this.deps.watchStates
    if (!states) return
    const previous = states.get(ws.id, issue.id)
    await states.set(ws.id, issue.id, {
      watchVersion: issue.watch.version,
      lastCheckedAt: nowMs,
      ...(previous && previous.watchVersion === issue.watch.version
        ? {
          ...(previous.lastTriggeredAt !== undefined ? { lastTriggeredAt: previous.lastTriggeredAt } : {}),
          ...(previous.lastStatus ? { lastStatus: previous.lastStatus } : {}),
          ...(previous.lastReason ? { lastReason: previous.lastReason } : {}),
          ...(previous.lastEvidence ? { lastEvidence: previous.lastEvidence } : {}),
          ...(previous.consumedSignalIds ? { consumedSignalIds: previous.consumedSignalIds } : {}),
          ...(previous.lastRunId ? { lastRunId: previous.lastRunId } : {}),
        }
        : {}),
    })
    this.deps.logger.info('schedule.watch_paused_skip', { wsId: ws.id, taskId: issue.id })
  }

  /** Due + watched fire: judge first, dispatch only on a fresh (unlatched)
   * hit. `miss` / `unavailable` / latched-hit record check memory and never
   * touch the dispatch path — zero LLM calls. A dispatch throw (capacity /
   * busy) leaves the hit unconsumed so the next due tick re-judges and
   * retries; only a successful dispatch latches + advances the schedule
   * marker. A per-issue check throw is isolated like an invalid file: the
   * issue keeps waiting with a visible reason instead of breaking the scan. */
  private async fireWatched(
    ws: WorkspaceMeta,
    issue: IssueRecord & { when: Schedule; watch: NonNullable<IssueRecord['watch']> },
    nowMs: number,
    shared: Map<string, Promise<WatchCheckVerdict>>,
  ): Promise<void> {
    const states = this.deps.watchStates!
    const checker = this.deps.watchChecker!
    const issueId = issue.id
    const previous = states.get(ws.id, issueId)
    // A re-armed plan (version bump) starts a fresh latch; otherwise the
    // previous trigger/consumption memory carries over.
    const rearmed = previous !== undefined && previous.watchVersion !== issue.watch.version
    const base: WatchRuntimeState = previous && !rearmed
      ? previous
      : { watchVersion: issue.watch.version, lastCheckedAt: previous?.lastCheckedAt ?? nowMs }

    let verdict: WatchCheckVerdict
    try {
      verdict = await this.sharedWatchVerdict(shared, issue.watch, nowMs, checker)
    } catch (err) {
      await states.set(ws.id, issueId, {
        ...base,
        watchVersion: issue.watch.version,
        lastCheckedAt: nowMs,
        lastStatus: 'unavailable',
        lastReason: `watch check failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      this.deps.logger.warn('schedule.watch_check_failed', { wsId: ws.id, taskId: issueId, err })
      return
    }

    if (verdict.status !== 'hit') {
      await states.set(ws.id, issueId, {
        ...base,
        watchVersion: issue.watch.version,
        lastCheckedAt: nowMs,
        lastStatus: verdict.status,
        ...(verdict.reason ? { lastReason: verdict.reason } : { lastReason: undefined }),
        lastEvidence: verdictEvidence(verdict),
      })
      this.deps.logger.info('schedule.watch_no_fire', {
        wsId: ws.id,
        taskId: issueId,
        status: verdict.status,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      })
      return
    }

    // Hit: latch on (version + consumed signal ids). A sustained hit with
    // no new signals and no re-arm stays silent — exactly-once per arming.
    // Signal-less hits (pure price/indicator leaves) latch on the version:
    // they fire once per arming and wait for the harness to re-arm.
    const freshSignals = verdict.signalIds.filter(
      (id) => !(base.consumedSignalIds ?? []).includes(id),
    )
    const latchable = verdict.signalIds.length === 0
      ? base.lastTriggeredAt === undefined
      : freshSignals.length > 0
    if (!latchable) {
      await states.set(ws.id, issueId, {
        ...base,
        watchVersion: issue.watch.version,
        lastCheckedAt: nowMs,
        lastStatus: 'hit',
        lastEvidence: verdictEvidence(verdict),
      })
      this.deps.logger.info('schedule.watch_latched', { wsId: ws.id, taskId: issueId })
      return
    }

    const consumed = verdict.signalIds.length === 0
      ? (base.consumedSignalIds ?? [])
      : [...(base.consumedSignalIds ?? []), ...freshSignals]
    // The dispatched prompt opens with the exact judgement that armed it:
    // verdict block + What. The block carries the dispatch's own run id,
    // which is known only after dispatch mints it — so dispatch What alone,
    // then rewrite the stored prompt with the block prepended (see
    // dispatchPromptWithVerdict below). What stays the executable
    // instruction; the block is provenance.
    try {
      const { taskId: runId } = await this.dispatchIssue(
        ws,
        issueId,
        issueFirePrompt(issue),
        issue.agent,
        issueRunOverrides(issue),
        issueAssigneeResumeId(issue.assignee) ?? undefined,
        issueAssigneeClaimsFirstSession(issue.assignee),
        issueTimeoutMs(issue.timeout),
        issue.connectorDesk,
      )
      const verdictBlock = issueWatchVerdictBlock({
        watchVersion: issue.watch.version,
        status: 'hit',
        leaves: verdict.leaves,
        evidence: { ...verdict.evidence },
        signalIds: verdict.signalIds,
        runId,
      })
      await this.deps.rewritePrompt?.(runId, `${verdictBlock}\n\n${issueFirePrompt(issue)}`)
      await this.deps.markers.set(ws.id, issueId, nowMs)
      await states.set(ws.id, issueId, {
        watchVersion: issue.watch.version,
        lastCheckedAt: nowMs,
        lastTriggeredAt: nowMs,
        lastStatus: 'hit',
        lastEvidence: verdictEvidence(verdict),
        consumedSignalIds: consumed,
        lastRunId: runId,
      })
      this.deps.logger.info('schedule.watch_fired', {
        wsId: ws.id,
        taskId: issueId,
        runId,
        signals: verdict.signalIds,
      })
    } catch (err) {
      // Admission skip: record the check but consume nothing — the hit
      // stays live and the next due tick re-judges (fresh data) and retries.
      await states.set(ws.id, issueId, {
        ...base,
        watchVersion: issue.watch.version,
        lastCheckedAt: nowMs,
        lastStatus: 'hit',
        lastReason: `dispatch skipped (${err instanceof Error ? err.message : String(err)}); hit unconsumed`,
        lastEvidence: verdictEvidence(verdict),
      })
      await this.noteCronMiss(ws.id, issueId, issue.when, nowMs)
      this.deps.logger.info('schedule.watch_fire_skipped', {
        wsId: ws.id,
        taskId: issueId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** One judgement per identical watch per scan. Concurrent issues share the
   * in-flight promise; a rejection is cached too so every holder records the
   * same `unavailable` instead of stampeding the source. */
  private sharedWatchVerdict(
    shared: Map<string, Promise<WatchCheckVerdict>>,
    watch: NonNullable<IssueRecord['watch']>,
    nowMs: number,
    checker: WatchChecker,
  ): Promise<WatchCheckVerdict> {
    const key = JSON.stringify(watch)
    const cached = shared.get(key)
    if (cached) return cached
    const pending = checker.check(watch, nowMs)
    shared.set(key, pending)
    return pending
  }

  private async noteCronMiss(
    wsId: string,
    taskId: string,
    when: Schedule,
    nowMs: number,
  ): Promise<void> {
    if (when.kind !== 'cron') return
    const last = this.deps.markers.get(wsId, taskId) ?? null
    const held = this.deps.markers.getHeld(wsId, taskId) ?? null
    const dueAt = computeNextRun(when, fireBase(when, last, nowMs, this.intervalMs, held))
    if (dueAt === null || dueAt > nowMs) return
    if (!scheduleCatchesUp(when)) {
      // Calendar-only means "the next future calendar occurrence", not "walk
      // every stale slot one scanner tick at a time". Advancing only to dueAt
      // would replay an entire backlog after sleep/downtime whenever admission
      // remained blocked. Use the current scan time as the consumed cursor.
      await this.deps.markers.hold(wsId, taskId, nowMs)
      return
    }
    if (last === null) await this.deps.markers.hold(wsId, taskId, dueAt - 1)
  }

  private async dispatchIssue(
    issueWorkspace: WorkspaceMeta,
    issueId: string,
    what: string,
    agentId?: string,
    selection?: SessionRuntimeSelection,
    resumeId?: string,
    claimFreshSession = false,
    timeoutMs?: number,
    connectorDesk?: string,
    manual = false,
    commentId?: string,
    retryOfTaskId?: string,
  ): Promise<{ taskId: string; resumeId: string }> {
    const dispatchKey = `${issueWorkspace.id}:${issueId}`
    if (this.dispatchingIssues.has(dispatchKey)) {
      if (manual) {
        throw new ScheduledIssueRunNowError(
          'already_running',
          'This Issue is already being dispatched.',
        )
      }
      throw new Error(`Issue dispatch already in progress: ${dispatchKey}`)
    }
    this.dispatchingIssues.add(dispatchKey)
    try {
      if (this.deps.isIssueRunning?.(issueWorkspace.id, issueId)) {
        throw new ScheduledIssueRunNowError('already_running', 'This Issue already has a run in progress.')
      }
      if (retryOfTaskId && this.deps.canRetryIssueRun && !this.deps.canRetryIssueRun(issueWorkspace.id, issueId, retryOfTaskId)) {
        throw new ScheduledIssueRunNowError('not_retryable', 'The failed run is no longer this Issue’s latest occurrence.')
      }
      // A scan or comment may have read the file before another dispatch claimed it.
      // Resolve ownership again while holding the shared dispatch exclusion.
      if (claimFreshSession || commentId) {
        const read = await readWorkspaceIssues(issueWorkspace.dir)
        const live = read.ok ? read.issues.find((issue) => issue.id === issueId) : undefined
        if (!live) throw new Error('Issue not found.')
        resumeId = issueAssigneeResumeId(live.assignee) ?? undefined
        claimFreshSession = issueAssigneeClaimsFirstSession(live.assignee)
        if (!resumeId && !claimFreshSession && live.assignee !== '@new-each-run') {
          throw new Error('Issue ownership changed; no Agent owner is selected.')
        }
        agentId = live.agent
        selection = issueRunOverrides(live)
        timeoutMs = issueTimeoutMs(live.timeout)
        if (commentId && !resumeId) {
          what = `Issue ${issueId}: ${live.title}\n${live.what}\n\nHistory: .alice/issues/${issueId}.comments.json\n\n${what}`
        }
      }
      const executionWorkspace = resumeId
        ? this.resolveResumeWorkspace(resumeId)
        : issueWorkspace
      if (!executionWorkspace) {
        throw new Error(`assigned Session Workspace is unavailable: ${resumeId}`)
      }
      const adapter = await this.deps.resolveAdapter(executionWorkspace, agentId, resumeId)
      if (!adapter.capabilities.headless || !adapter.composeHeadlessCommand) {
        throw new Error(`agent runtime does not support headless work: ${adapter.id}`)
      }
      const trigger: HeadlessTaskTrigger | undefined = commentId ? undefined : {
        kind: 'issue',
        ...(retryOfTaskId ? { retryOfTaskId } : {}),
        workspaceId: issueWorkspace.id,
        issueId,
        ...(connectorDesk
          ? {
              metadata: {
                kind: 'connector-cron-issue' as const,
                connectorId: connectorDesk,
              },
            }
          : {}),
      }
      // Fresh recruits only: exact @resumeId continues an existing Session.
      const createdBy: SessionCreatedBy | undefined = resumeId
        ? undefined
        : {
            kind: 'issue',
            workspaceId: issueWorkspace.id,
            issueId,
            policy: claimFreshSession ? 'new-then-resume' : 'new-each-run',
            fire: commentId ? 'comment' : manual ? (retryOfTaskId ? 'retry' : 'manual') : 'schedule',
          }
      const inquiry: HeadlessTaskInquiry | undefined = commentId ? {
        subject: { kind: 'issue', workspaceId: issueWorkspace.id, issueId, relation: 'owner', commentId },
        question: what,
        resolution: { mode: resumeId ? 'exact' : 'reconstructed' },
      } : undefined
      const result = inquiry
        ? await this.deps.dispatch(executionWorkspace, adapter, what, timeoutMs, undefined,
            resumeId, inquiry, selection, undefined, createdBy)
        : resumeId
        ? selection
          ? await this.deps.dispatch(
              executionWorkspace,
              adapter,
              what,
              timeoutMs,
              trigger,
              resumeId,
              undefined,
              selection,
            )
          : await this.deps.dispatch(
              executionWorkspace,
              adapter,
              what,
              timeoutMs,
              trigger,
              resumeId,
            )
        : selection
          ? await this.deps.dispatch(
              executionWorkspace,
              adapter,
              what,
              timeoutMs,
              trigger,
              undefined,
              undefined,
              selection,
              undefined,
              createdBy,
            )
          : await this.deps.dispatch(
              executionWorkspace,
              adapter,
              what,
              timeoutMs,
              trigger,
              undefined,
              undefined,
              undefined,
              undefined,
              createdBy,
            )
      if (claimFreshSession) {
        if (!this.deps.claimFreshSession) {
          throw new Error('Issue @new-then-resume ownership cannot be persisted in this runtime')
        }
        try {
          await this.deps.claimFreshSession({
            issueWorkspace,
            issueId,
            taskId: result.taskId,
            resumeId: result.resumeId,
            agent: adapter.id,
          })
        } catch (err) {
          // The worker is already running. Treat a claim-write failure as a
          // separate control-plane fault so the due loop cannot immediately
          // recruit a second worker for the same occurrence.
          this.deps.logger.warn('schedule.first_session_claim_failed', {
            wsId: issueWorkspace.id,
            issueId,
            taskId: result.taskId,
            resumeId: result.resumeId,
            err,
          })
        }
      }
      this.deps.logger.info('schedule.issue_dispatched', {
        wsId: issueWorkspace.id,
        executionWsId: executionWorkspace.id,
        issueId,
        agent: adapter.id,
        runId: result.taskId,
        manual,
      })
      return result
    } finally {
      this.dispatchingIssues.delete(dispatchKey)
    }
  }

  private resolveResumeWorkspace(resumeId: string): WorkspaceMeta | undefined {
    return this.deps.resolveResumeWorkspace?.(resumeId)
  }
}

/** Compact evidence for watch state + display: actuals per leaf, the data
 * window, and the arming version. Signal ids live beside it, not inside. */
function verdictEvidence(verdict: WatchCheckVerdict): Record<string, unknown> {
  return {
    status: verdict.status,
    leaves: verdict.leaves.map((leaf) => ({
      index: leaf.index,
      status: leaf.status,
      ...(leaf.actual !== undefined ? { actual: leaf.actual } : {}),
      ...(leaf.expected !== undefined ? { expected: leaf.expected } : {}),
      ...(leaf.reason ? { reason: leaf.reason } : {}),
    })),
    evidence: verdict.evidence,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  }
}

function issueRunOverrides(issue: IssueRecord): SessionRuntimeSelection | undefined {
  if (!issue.credential && !issue.credentialSource && !issue.model && !issue.effort) return undefined
  return {
    ...(issue.credentialSource === 'native' ? { credentialSource: 'native' as const } : {}),
    ...(issue.credential ? { credentialSlug: issue.credential } : {}),
    ...(issue.model ? { model: issue.model } : {}),
    ...(issue.effort ? { reasoningEffort: issue.effort } : {}),
  }
}
