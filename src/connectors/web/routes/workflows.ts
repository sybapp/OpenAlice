import { Hono } from 'hono'
import type { EventLogEntry } from '../../../core/event-log.js'
import type { EngineContext } from '../../../core/types.js'
import type { TraderWorkflowStage, TraderWorkflowStageEventPayload } from '../../../jobs/strategies/types.js'

type TraderWorkflowStatus = 'running' | 'done' | 'skip' | 'error'

interface TraderWorkflowRunSummary {
  runId: string
  jobId: string
  jobName?: string
  strategyId: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: TraderWorkflowStatus
  endedStage: TraderWorkflowStage | null
  headline: string
}

interface TraderWorkflowStageEntry {
  seq: number
  ts: number
  stage: TraderWorkflowStage
  status: TraderWorkflowStageEventPayload['status']
  data: unknown
}

interface TraderWorkflowRunDetail {
  summary: TraderWorkflowRunSummary
  stages: TraderWorkflowStageEntry[]
  terminalEvent: EventLogEntry | null
}

interface TraderWorkflowRunAggregate {
  runId: string
  fire: EventLogEntry<Record<string, unknown>>
  stages: EventLogEntry<TraderWorkflowStageEventPayload>[]
  terminal: EventLogEntry<Record<string, unknown>> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isTerminalType(type: string): boolean {
  return type === 'trader.done' || type === 'trader.skip' || type === 'trader.error'
}

function terminalStatus(type: string): TraderWorkflowStatus {
  if (type === 'trader.done') return 'done'
  if (type === 'trader.skip') return 'skip'
  if (type === 'trader.error') return 'error'
  return 'running'
}

function terminalHeadline(entry: EventLogEntry<Record<string, unknown>> | null): string | null {
  if (!entry) return null
  return asString(entry.payload.error) ?? asString(entry.payload.reason) ?? null
}

function aggregateTraderRuns(entries: EventLogEntry[]): TraderWorkflowRunAggregate[] {
  const runs = new Map<string, TraderWorkflowRunAggregate>()

  for (const entry of entries) {
    if (entry.type === 'trader.fire' && isRecord(entry.payload)) {
      const runId = String(entry.seq)
      runs.set(runId, {
        runId,
        fire: entry as EventLogEntry<Record<string, unknown>>,
        stages: [],
        terminal: null,
      })
      continue
    }

    if (!isRecord(entry.payload)) continue
    const runId = asString(entry.payload.runId)
    if (!runId) continue
    const current = runs.get(runId)
    if (!current) continue

    if (entry.type === 'trader.stage') {
      current.stages.push(entry as EventLogEntry<TraderWorkflowStageEventPayload>)
      continue
    }

    if (isTerminalType(entry.type)) {
      current.terminal = entry as EventLogEntry<Record<string, unknown>>
    }
  }

  return [...runs.values()]
}

function toRunSummary(run: TraderWorkflowRunAggregate): TraderWorkflowRunSummary {
  const firePayload = run.fire.payload
  const lastStage = run.stages[run.stages.length - 1]
  const terminal = run.terminal
  const startedAt = run.fire.ts
  const endedAt = terminal?.ts ?? lastStage?.ts ?? null
  const headline = terminalHeadline(terminal)
    ?? (lastStage && isRecord(lastStage.payload.data) ? asString(lastStage.payload.data.reason) ?? asString(lastStage.payload.data.rationale) ?? null : null)
    ?? 'In progress.'

  return {
    runId: run.runId,
    jobId: asString(firePayload.jobId) ?? 'unknown-job',
    jobName: asString(firePayload.jobName),
    strategyId: asString(firePayload.strategyId) ?? 'unknown-strategy',
    startedAt,
    endedAt,
    durationMs: endedAt ? Math.max(0, endedAt - startedAt) : null,
    status: terminal ? terminalStatus(terminal.type) : 'running',
    endedStage: lastStage?.payload.stage ?? null,
    headline,
  }
}

function toRunDetail(run: TraderWorkflowRunAggregate): TraderWorkflowRunDetail {
  return {
    summary: toRunSummary(run),
    stages: run.stages.map((entry) => ({
      seq: entry.seq,
      ts: entry.ts,
      stage: entry.payload.stage,
      status: entry.payload.status,
      data: entry.payload.data,
    })),
    terminalEvent: run.terminal,
  }
}

export function createWorkflowRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/trader-runs', async (c) => {
    const page = Math.max(1, Number(c.req.query('page')) || 1)
    const pageSize = Math.min(Math.max(1, Number(c.req.query('pageSize')) || 20), 100)
    const status = c.req.query('status') || undefined
    const strategyId = c.req.query('strategyId') || undefined

    const allEntries = await ctx.eventLog.read()
    const runs = aggregateTraderRuns(allEntries)
      .map(toRunSummary)
      .filter((run) => (!status || run.status === status) && (!strategyId || run.strategyId === strategyId))
      .sort((a, b) => b.startedAt - a.startedAt)

    const total = runs.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const start = (page - 1) * pageSize
    const entries = runs.slice(start, start + pageSize)

    return c.json({
      entries,
      total,
      page,
      pageSize,
      totalPages,
    })
  })

  app.get('/trader-runs/:runId', async (c) => {
    const runId = c.req.param('runId')
    const allEntries = await ctx.eventLog.read()
    const run = aggregateTraderRuns(allEntries).find((entry) => entry.runId === runId)
    if (!run) {
      return c.json({ error: `workflow run not found: ${runId}` }, 404)
    }
    return c.json(toRunDetail(run))
  })

  return app
}
