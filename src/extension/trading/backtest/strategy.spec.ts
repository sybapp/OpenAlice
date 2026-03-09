import { describe, it, expect, vi } from 'vitest'
import { ScriptedBacktestStrategyDriver } from './strategy-scripted.js'
import { AIBacktestStrategyDriver } from './strategy-ai.js'
import { SessionStore } from '../../../core/session.js'
import { createEventLog } from '../../../core/event-log.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function tempPath(name: string) {
  return join(tmpdir(), `backtest-${name}-${randomUUID()}.jsonl`)
}

describe('backtest strategy drivers', () => {
  it('scripted driver calls strategy deterministically with same context', async () => {
    const strategy = vi.fn().mockResolvedValue([
      { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } },
    ])
    const driver = new ScriptedBacktestStrategyDriver({ strategy })
    const context = {
      runId: 'run-1',
      step: 1,
      timestamp: '2025-01-01T09:30:00.000Z',
      accountId: 'backtest-paper',
      bars: [{ symbol: 'AAPL', close: 100 }],
    }

    const first = await driver.decide(context)
    const second = await driver.decide(context)

    expect(strategy).toHaveBeenCalledTimes(2)
    expect(first).toEqual(second)
  })

  it('ai driver writes audit trail to session and event log', async () => {
    const session = new SessionStore(`backtest/test-${randomUUID()}`)
    const eventLog = await createEventLog({ logPath: tempPath('events') })
    const ask = vi.fn().mockResolvedValue({
      text: 'buy 1 share',
      operations: [
        { action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 } },
      ],
    })

    const driver = new AIBacktestStrategyDriver({
      ask,
      session,
      eventLog,
    })

    const result = await driver.decide({
      runId: 'run-1',
      step: 1,
      timestamp: '2025-01-01T09:30:00.000Z',
      accountId: 'backtest-paper',
      bars: [{ symbol: 'AAPL', close: 100 }],
    })

    expect(result.operations).toHaveLength(1)

    const sessionEntries = await session.readAll()
    expect(sessionEntries.length).toBeGreaterThan(0)

    const events = await eventLog.read()
    expect(events.some((entry) => entry.type === 'backtest.strategy.ai.decision')).toBe(true)

    await eventLog._resetForTest()
  })
})
