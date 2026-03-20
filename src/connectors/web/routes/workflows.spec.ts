import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../../core/event-log.js'
import { createWorkflowRoutes } from './workflows.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `workflow-routes-test-${randomUUID()}.${ext}`)
}

describe('createWorkflowRoutes', () => {
  let eventLog: EventLog

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
  })

  afterEach(async () => {
    await eventLog._resetForTest()
  })

  it('lists trader runs grouped by runId and ignores legacy events without runId', async () => {
    const fire = await eventLog.append('trader.fire', {
      jobId: 'job-1',
      jobName: 'BTCUSDT',
      strategyId: 'mean-revert',
    })
    await eventLog.append('trader.stage', {
      runId: String(fire.seq),
      jobId: 'job-1',
      jobName: 'BTCUSDT',
      strategyId: 'mean-revert',
      stage: 'market-scan',
      status: 'skipped',
      data: {
        summary: '',
        evaluations: [{ symbol: 'BTC/USDT:USDT', source: 'Main Account', verdict: 'skip', reason: 'No rejection candle.' }],
      },
    })
    await eventLog.append('trader.skip', {
      runId: String(fire.seq),
      jobId: 'job-1',
      jobName: 'BTCUSDT',
      strategyId: 'mean-revert',
      reason: 'BTC/USDT:USDT on Main Account: No rejection candle.',
    })
    await eventLog.append('trader.skip', {
      jobId: 'legacy',
      strategyId: 'legacy-strategy',
      reason: 'legacy event without run id',
    })

    const app = createWorkflowRoutes({ eventLog } as any)
    const res = await app.request('/trader-runs')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      entries: [
        expect.objectContaining({
          runId: String(fire.seq),
          jobId: 'job-1',
          jobName: 'BTCUSDT',
          strategyId: 'mean-revert',
          status: 'skip',
          endedStage: 'market-scan',
          headline: 'BTC/USDT:USDT on Main Account: No rejection candle.',
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    })
  })

  it('returns trader workflow detail with stages and terminal event', async () => {
    const fire = await eventLog.append('trader.fire', {
      jobId: 'job-2',
      jobName: 'Momentum',
      strategyId: 'momentum',
    })
    await eventLog.append('trader.stage', {
      runId: String(fire.seq),
      jobId: 'job-2',
      jobName: 'Momentum',
      strategyId: 'momentum',
      stage: 'market-scan',
      status: 'completed',
      data: {
        summary: 'best setup found',
        candidates: [{ source: 'Main Account', symbol: 'BTC/USDT:USDT', reason: 'best setup' }],
      },
    })
    await eventLog.append('trader.stage', {
      runId: String(fire.seq),
      jobId: 'job-2',
      jobName: 'Momentum',
      strategyId: 'momentum',
      stage: 'trade-thesis',
      status: 'completed',
      data: {
        source: 'Main Account',
        symbol: 'BTC/USDT:USDT',
        bias: 'long',
        chosenScenario: 'breakout continuation',
        rationale: 'Structure is aligned.',
      },
    })
    await eventLog.append('trader.done', {
      runId: String(fire.seq),
      jobId: 'job-2',
      jobName: 'Momentum',
      strategyId: 'momentum',
      reason: 'Execution confirmed.',
    })

    const app = createWorkflowRoutes({ eventLog } as any)
    const res = await app.request(`/trader-runs/${fire.seq}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      summary: expect.objectContaining({
        runId: String(fire.seq),
        status: 'done',
        endedStage: 'trade-thesis',
      }),
      stages: [
        expect.objectContaining({
          stage: 'market-scan',
          status: 'completed',
        }),
        expect.objectContaining({
          stage: 'trade-thesis',
          status: 'completed',
        }),
      ],
      terminalEvent: expect.objectContaining({
        type: 'trader.done',
      }),
    })
  })
})
