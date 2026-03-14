import type { BacktestStrategyDecision, BacktestStrategyContext, ScriptedStrategyDriverOptions } from './types.js'

export class ScriptedBacktestStrategyDriver {
  constructor(private readonly options: ScriptedStrategyDriverOptions) {}

  async decide(context: BacktestStrategyContext): Promise<BacktestStrategyDecision> {
    const operations = await this.options.strategy(context)
    return { operations }
  }
}
