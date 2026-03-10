import type { AIBacktestStrategyDriverOptions, BacktestStrategyContext, BacktestStrategyDecision } from './types.js'

export class AIBacktestStrategyDriver {
  constructor(private readonly options: AIBacktestStrategyDriverOptions) {}

  async decide(context: BacktestStrategyContext): Promise<BacktestStrategyDecision> {
    const response = await this.options.ask(context)

    await this.options.eventLog.append('backtest.strategy.ai.decision', {
      runId: context.runId,
      step: context.step,
      timestamp: context.timestamp,
      text: response.text ?? '',
      operations: response.operations ?? [],
    })

    return {
      operations: response.operations ?? [],
      summaryText: response.text,
    }
  }
}
