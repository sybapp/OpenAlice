import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventLog } from '../../core/event-log.js'
import { computeNextRun } from '../cron/engine.js'
import type {
  TraderReviewFirePayload,
  TraderReviewJob,
  TraderReviewJobCreate,
  TraderReviewJobEngine,
  TraderReviewJobPatch,
} from './types.js'

interface TraderReviewJobEngineOpts {
  eventLog: EventLog
  storePath?: string
  now?: () => number
}

function errorBackoffMs(consecutiveErrors: number): number {
  const base = 10_000
  const cappedExponent = Math.min(6, Math.max(0, consecutiveErrors - 1))
  return base * (2 ** cappedExponent)
}

export function createTraderReviewJobEngine(opts: TraderReviewJobEngineOpts): TraderReviewJobEngine {
  const { eventLog } = opts
  const storePath = opts.storePath ?? 'runtime/strategies/review-jobs.json'
  const now = opts.now ?? Date.now

  let jobs: TraderReviewJob[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function load(): Promise<void> {
    try {
      const raw = await readFile(storePath, 'utf-8')
      const parsed = JSON.parse(raw) as { jobs?: TraderReviewJob[] }
      jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        jobs = []
        return
      }
      throw err
    }
  }

  async function save(): Promise<void> {
    await mkdir(dirname(storePath), { recursive: true })
    const tmp = `${storePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ jobs }, null, 2), 'utf-8')
    await rename(tmp, storePath)
  }

  function armTimer(): void {
    if (stopped) return
    const nextMs = jobs
      .filter((job) => job.enabled && job.state.nextRunAtMs !== null)
      .reduce<number | null>((min, job) => {
        const runAt = job.state.nextRunAtMs!
        return min === null ? runAt : Math.min(min, runAt)
      }, null)

    if (nextMs === null) return
    const delayMs = Math.max(0, Math.min(nextMs - now(), 60_000))
    timer = setTimeout(onTick, delayMs)
  }

  async function onTick(): Promise<void> {
    timer = null
    if (stopped) return
    const currentMs = now()
    const dueJobs = jobs.filter(
      (job) => job.enabled && job.state.nextRunAtMs !== null && job.state.nextRunAtMs <= currentMs,
    )

    for (const job of dueJobs) {
      await fireJob(job, currentMs)
    }

    if (!stopped) {
      await save()
      armTimer()
    }
  }

  async function fireJob(job: TraderReviewJob, currentMs: number): Promise<void> {
    job.state.lastRunAtMs = currentMs
    try {
      await eventLog.append('trader.review.fire', {
        jobId: job.id,
        jobName: job.name,
        strategyId: job.strategyId,
      } satisfies TraderReviewFirePayload)
      job.state.lastStatus = 'ok'
      job.state.consecutiveErrors = 0
    } catch {
      job.state.lastStatus = 'error'
      job.state.consecutiveErrors += 1
    }

    if (job.state.consecutiveErrors > 0) {
      job.state.nextRunAtMs = currentMs + errorBackoffMs(job.state.consecutiveErrors)
      return
    }

    if (job.schedule.kind === 'at') {
      job.enabled = false
      job.state.nextRunAtMs = null
      return
    }

    job.state.nextRunAtMs = computeNextRun(job.schedule, currentMs)
  }

  return {
    async start() {
      stopped = false
      await load()
      const currentMs = now()
      for (const job of jobs) {
        if (!job.enabled) continue
        if (job.state.nextRunAtMs === null || job.state.nextRunAtMs < currentMs) {
          job.state.nextRunAtMs = computeNextRun(job.schedule, currentMs)
          if (job.schedule.kind === 'at' && job.state.nextRunAtMs === null) {
            job.enabled = false
          }
        }
      }
      await save()
      armTimer()
    },

    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },

    async add(params) {
      const id = randomUUID().slice(0, 8)
      const currentMs = now()
      jobs.push({
        id,
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        strategyId: params.strategyId,
        createdAt: currentMs,
        state: {
          nextRunAtMs: computeNextRun(params.schedule, currentMs),
          lastRunAtMs: null,
          lastStatus: null,
          consecutiveErrors: 0,
        },
      })
      await save()
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      armTimer()
      return id
    },

    async update(id, patch: TraderReviewJobPatch) {
      const job = jobs.find((entry) => entry.id === id)
      if (!job) throw new Error(`trader review job not found: ${id}`)
      if (patch.name !== undefined) job.name = patch.name
      if (patch.enabled !== undefined) job.enabled = patch.enabled
      if (patch.strategyId !== undefined) job.strategyId = patch.strategyId
      if (patch.schedule !== undefined) {
        job.schedule = patch.schedule
        job.state.nextRunAtMs = computeNextRun(job.schedule, now())
        job.state.consecutiveErrors = 0
      }
      await save()
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      armTimer()
    },

    async remove(id) {
      const index = jobs.findIndex((entry) => entry.id === id)
      if (index === -1) throw new Error(`trader review job not found: ${id}`)
      jobs.splice(index, 1)
      await save()
    },

    list() {
      return [...jobs]
    },

    async runNow(id) {
      const job = jobs.find((entry) => entry.id === id)
      if (!job) throw new Error(`trader review job not found: ${id}`)
      await fireJob(job, now())
      await save()
    },

    get(id) {
      return jobs.find((entry) => entry.id === id)
    },
  }
}
