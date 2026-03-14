import type { BacktestRunSummary, BacktestRunnerOptions } from './types.js'

export class BacktestRunner {
  constructor(private readonly options: BacktestRunnerOptions) {}

  async run(): Promise<BacktestRunSummary> {
    const startState = await this.options.getGitState()
    let maxEquity = startState.equity
    let maxDrawdown = 0
    let tradeCount = 0
    let closedTradeCount = 0
    let guardRejectionCount = 0
    let winningClosedTradeCount = 0
    let step = 1

    await this.options.eventLog.append('backtest.run.started', {
      runId: this.options.runId,
      ts: this.options.replay.getCurrentTime().toISOString(),
      startEquity: startState.equity,
    })

    while (true) {
      this.options.git.setCurrentRound(step)

      const pendingOrders = this.options.git.getPendingOrderIds()
      const syncUpdates = await this.options.account.syncPendingOrders(pendingOrders.map((entry) => entry.orderId))
      if (syncUpdates.length > 0) {
        const syncState = await this.options.getGitState()
        await this.options.git.sync(syncUpdates, syncState)
        const syncFills = syncUpdates.filter((update) => update.currentStatus === 'filled')
        tradeCount += syncFills.length
        const closedFills = syncFills.filter((update) => update.realizedPnLDelta != null)
        closedTradeCount += closedFills.length
        winningClosedTradeCount += closedFills.filter((update) => (update.realizedPnLDelta ?? 0) > 0).length
      }

      const [account, positions, orders] = await Promise.all([
        this.options.account.getAccount(),
        this.options.account.getPositions(),
        this.options.account.getOrders(),
      ])

      const decision = await this.options.strategyDriver.decide({
        runId: this.options.runId,
        step,
        timestamp: this.options.replay.getCurrentTime().toISOString(),
        accountId: this.options.account.id,
        bars: this.options.replay.getCurrentBars(),
        account,
        positions,
        orders,
      })

      if (decision.operations.length > 0) {
        for (const operation of decision.operations) {
          this.options.git.add(operation)
        }
        this.options.git.commit(`[backtest] step ${step}`)
        const pushResult = await this.options.git.push()
        tradeCount += pushResult.filled.length
        guardRejectionCount += pushResult.rejected.length
      }

      const state = await this.options.getGitState()
      if (state.equity > maxEquity) maxEquity = state.equity
      const drawdown = maxEquity > 0 ? (maxEquity - state.equity) / maxEquity : 0
      if (drawdown > maxDrawdown) maxDrawdown = drawdown

      const snapshot = {
        runId: this.options.runId,
        step,
        ts: this.options.replay.getCurrentTime().toISOString(),
        equity: state.equity,
        realizedPnL: state.realizedPnL,
        unrealizedPnL: state.unrealizedPnL,
      }

      await this.options.eventLog.append('backtest.run.step', snapshot)
      await this.options.onStep?.(snapshot)

      if (!this.options.replay.step()) break
      step += 1
    }

    const endState = await this.options.getGitState()
    const summary: BacktestRunSummary = {
      runId: this.options.runId,
      startEquity: startState.equity,
      endEquity: endState.equity,
      totalReturn: startState.equity > 0 ? (endState.equity - startState.equity) / startState.equity : 0,
      realizedPnL: endState.realizedPnL,
      unrealizedPnL: endState.unrealizedPnL,
      maxDrawdown,
      tradeCount,
      winRate: closedTradeCount > 0 ? winningClosedTradeCount / closedTradeCount : 0,
      guardRejectionCount,
    }

    await this.options.eventLog.append('backtest.run.completed', summary)
    return summary
  }
}
