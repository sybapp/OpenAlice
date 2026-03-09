import { describe, it, expect } from 'vitest'
import { createEventLog } from '../../../core/event-log.js'
import { HistoricalMarketReplay } from './HistoricalMarketReplay.js'
import { BacktestAccount } from './BacktestAccount.js'
import { BacktestRunner } from './BacktestRunner.js'
import { ScriptedBacktestStrategyDriver } from './strategy-scripted.js'
import { wireAccountTrading } from '../factory.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function tempPath(name: string) {
  return join(tmpdir(), `backtest-${name}-${randomUUID()}.jsonl`)
}

function makeBars() {
  return [
    { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 105, low: 99, close: 102, volume: 1_000 },
    { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 103, high: 106, low: 101, close: 104, volume: 1_000 },
    { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 104, high: 108, low: 103, close: 107, volume: 1_000 },
  ]
}

describe('BacktestRunner integration', () => {
  it('reuses TradingGit, guards, wallet bridge, and runner for deterministic scripted runs', async () => {
    const eventLog = await createEventLog({ logPath: tempPath('events') })
    const replayA = new HistoricalMarketReplay({ bars: makeBars() })
    await replayA.init()
    const accountA = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay: replayA, initialCash: 10_000 })
    await accountA.init()
    const setupA = wireAccountTrading(accountA, {
      guards: [{ type: 'symbol-whitelist', options: { symbols: ['AAPL'] } }],
    })

    const strategy = new ScriptedBacktestStrategyDriver({
      strategy: async ({ step }: { step: number }) => step === 1
        ? [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }]
        : [],
    })

    const runnerA = new BacktestRunner({
      runId: 'run-a',
      replay: replayA,
      account: accountA,
      git: setupA.git,
      getGitState: setupA.getGitState,
      eventLog,
      strategyDriver: strategy,
    })

    const summaryA = await runnerA.run()

    const replayB = new HistoricalMarketReplay({ bars: makeBars() })
    await replayB.init()
    const accountB = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay: replayB, initialCash: 10_000 })
    await accountB.init()
    const setupB = wireAccountTrading(accountB, {
      guards: [{ type: 'symbol-whitelist', options: { symbols: ['AAPL'] } }],
    })
    const runnerB = new BacktestRunner({
      runId: 'run-b',
      replay: replayB,
      account: accountB,
      git: setupB.git,
      getGitState: setupB.getGitState,
      eventLog,
      strategyDriver: strategy,
    })

    const summaryB = await runnerB.run()

    expect({ ...summaryA, runId: 'same' }).toEqual({ ...summaryB, runId: 'same' })
    expect(setupA.git.log().length).toBeGreaterThan(0)
    expect(summaryA.tradeCount).toBe(1)
    expect(summaryA.startEquity).toBe(10_000)
    expect(summaryA.endEquity).toBeGreaterThan(10_000)

    const commits = setupA.git.log({ limit: 10 })
    expect(commits.some((commit) => commit.message.startsWith('[backtest] step 1'))).toBe(true)
    expect(commits.some((commit) => commit.message.startsWith('[sync]'))).toBe(true)

    await eventLog._resetForTest()
  })

  it('syncs pending orders before strategy decisions on the next step', async () => {
    const eventLog = await createEventLog({ logPath: tempPath('sync-order') })
    const replay = new HistoricalMarketReplay({ bars: makeBars() })
    await replay.init()
    const account = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay, initialCash: 10_000 })
    await account.init()
    const setup = wireAccountTrading(account, {})
    const seenSteps: Array<{ step: number; orders: string[] }> = []

    const runner = new BacktestRunner({
      runId: 'run-sync-order',
      replay,
      account,
      git: setup.git,
      getGitState: setup.getGitState,
      eventLog,
      strategyDriver: new ScriptedBacktestStrategyDriver({
        strategy: async ({ step, orders = [] }) => {
          seenSteps.push({ step, orders: orders.map((order) => order.status) })
          return step === 1
            ? [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }]
            : []
        },
      }),
    })

    await runner.run()

    expect(seenSteps[0]).toEqual({ step: 1, orders: [] })
    expect(seenSteps[1]).toEqual({ step: 2, orders: ['filled'] })

    const firstCommit = setup.git.log({ limit: 10 }).find((commit) => commit.message.startsWith('[backtest] step 1'))
    const syncCommit = setup.git.log({ limit: 10 }).find((commit) => commit.message.startsWith('[sync]'))
    expect(firstCommit).toBeDefined()
    expect(syncCommit).toBeDefined()

    const pendingAfterRun = setup.git.getPendingOrderIds()
    expect(pendingAfterRun).toEqual([])

    await eventLog._resetForTest()
  })

  it('does not create sync commits when pending order state does not change', async () => {
    const eventLog = await createEventLog({ logPath: tempPath('no-sync') })
    const replay = new HistoricalMarketReplay({ bars: makeBars() })
    await replay.init()
    const account = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay, initialCash: 10_000 })
    await account.init()
    const setup = wireAccountTrading(account, {})

    const runner = new BacktestRunner({
      runId: 'run-no-sync',
      replay,
      account,
      git: setup.git,
      getGitState: setup.getGitState,
      eventLog,
      strategyDriver: new ScriptedBacktestStrategyDriver({
        strategy: async ({ step }) => step === 1
          ? [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, price: 97 } }]
          : [],
      }),
    })

    const summary = await runner.run()
    const syncCommits = setup.git.log({ limit: 10 }).filter((commit) => commit.message.startsWith('[sync]'))

    expect(summary.tradeCount).toBe(0)
    expect(syncCommits).toHaveLength(0)
    expect(setup.git.getPendingOrderIds()).toHaveLength(1)

    await eventLog._resetForTest()
  })

  it('reports winRate as 0 for losing closed trades', async () => {
    const eventLog = await createEventLog({ logPath: tempPath('losing-win-rate') })
    const replay = new HistoricalMarketReplay({
      bars: [
        { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 90, high: 91, low: 89, close: 90, volume: 1_000 },
      ],
    })
    await replay.init()
    const account = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay, initialCash: 10_000 })
    await account.init()
    const setup = wireAccountTrading(account, {})

    const runner = new BacktestRunner({
      runId: 'run-loss',
      replay,
      account,
      git: setup.git,
      getGitState: setup.getGitState,
      eventLog,
      strategyDriver: new ScriptedBacktestStrategyDriver({
        strategy: async ({ step }) => {
          if (step === 1) {
            return [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }]
          }
          if (step === 2) {
            return [{ action: 'closePosition', params: { symbol: 'AAPL', qty: 10 } }]
          }
          return []
        },
      }),
    })

    const summary = await runner.run()

    expect(summary.realizedPnL).toBeLessThan(0)
    expect(summary.tradeCount).toBe(2)
    expect(summary.winRate).toBe(0)

    await eventLog._resetForTest()
  })

  it('reports winRate as 1 for profitable closed trades', async () => {
    const eventLog = await createEventLog({ logPath: tempPath('winning-win-rate') })
    const replay = new HistoricalMarketReplay({
      bars: [
        { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        { ts: '2025-01-01T09:31:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
        { ts: '2025-01-01T09:32:00.000Z', symbol: 'AAPL', open: 110, high: 111, low: 109, close: 110, volume: 1_000 },
      ],
    })
    await replay.init()
    const account = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay, initialCash: 10_000 })
    await account.init()
    const setup = wireAccountTrading(account, {})

    const runner = new BacktestRunner({
      runId: 'run-win',
      replay,
      account,
      git: setup.git,
      getGitState: setup.getGitState,
      eventLog,
      strategyDriver: new ScriptedBacktestStrategyDriver({
        strategy: async ({ step }) => {
          if (step === 1) {
            return [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }]
          }
          if (step === 2) {
            return [{ action: 'closePosition', params: { symbol: 'AAPL', qty: 10 } }]
          }
          return []
        },
      }),
    })

    const summary = await runner.run()

    expect(summary.realizedPnL).toBeGreaterThan(0)
    expect(summary.tradeCount).toBe(2)
    expect(summary.winRate).toBe(1)

    await eventLog._resetForTest()
  })

  it('records guard rejections in commit history and summary', async () => {
    const eventLog = await createEventLog({ logPath: tempPath('guard-events') })
    const replay = new HistoricalMarketReplay({ bars: makeBars() })
    await replay.init()
    const account = new BacktestAccount({ id: 'backtest-paper', label: 'Backtest Paper', replay, initialCash: 10_000 })
    await account.init()
    const setup = wireAccountTrading(account, {
      guards: [{ type: 'symbol-whitelist', options: { symbols: ['MSFT'] } }],
    })

    const runner = new BacktestRunner({
      runId: 'run-guard',
      replay,
      account,
      git: setup.git,
      getGitState: setup.getGitState,
      eventLog,
      strategyDriver: new ScriptedBacktestStrategyDriver({
        strategy: async ({ step }) => step === 1
          ? [{ action: 'placeOrder', params: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 } }]
          : [],
      }),
    })

    const summary = await runner.run()
    const commit = setup.git.log()[0]

    expect(summary.guardRejectionCount).toBe(1)
    expect(commit.operations[0].status).toBe('rejected')

    await eventLog._resetForTest()
  })
})
