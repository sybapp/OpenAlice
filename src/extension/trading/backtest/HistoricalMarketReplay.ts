import type { Quote } from '../interfaces.js'
import type { BacktestBar, HistoricalMarketReplayOptions } from './types.js'

export class HistoricalMarketReplay {
  private readonly bars: BacktestBar[]
  private currentIndex = 0
  private currentBars: BacktestBar[] = []
  private currentBarsBySymbol = new Map<string, BacktestBar>()
  private initialized = false

  constructor(private readonly options: HistoricalMarketReplayOptions) {
    this.bars = [...options.bars].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
  }

  async init(): Promise<void> {
    if (this.bars.length === 0) {
      throw new Error('No historical bars available')
    }

    if (this.options.startTime) {
      const startTs = new Date(this.options.startTime).getTime()
      const index = this.bars.findIndex((bar) => new Date(bar.ts).getTime() >= startTs)
      this.currentIndex = index >= 0 ? index : this.bars.length - 1
    }

    this.refreshCurrentBars()
    this.initialized = true
  }

  getBars(): BacktestBar[] {
    this.ensureInitialized()
    return [...this.bars]
  }

  getCurrentBars(): BacktestBar[] {
    this.ensureInitialized()
    return [...this.currentBars]
  }

  getCurrentIndex(): number {
    this.ensureInitialized()
    return this.currentIndex
  }

  getCurrentTime(): Date {
    this.ensureInitialized()
    return new Date(this.bars[this.currentIndex].ts)
  }

  getCurrentQuote(symbol: string): Quote {
    this.ensureInitialized()
    const bar = this.currentBarsBySymbol.get(symbol)
    if (!bar) {
      throw new Error(`No bar for symbol: ${symbol}`)
    }
    return {
      contract: { symbol: bar.symbol },
      last: bar.close,
      bid: bar.bid ?? bar.close,
      ask: bar.ask ?? bar.close,
      volume: bar.volume,
      high: bar.high,
      low: bar.low,
      timestamp: new Date(bar.ts),
    }
  }

  step(): boolean {
    this.ensureInitialized()
    if (this.currentIndex >= this.bars.length - 1) {
      return false
    }

    const currentTs = this.bars[this.currentIndex].ts
    let nextIndex = this.currentIndex + 1
    while (nextIndex < this.bars.length && this.bars[nextIndex].ts === currentTs) {
      nextIndex += 1
    }
    if (nextIndex >= this.bars.length) {
      return false
    }

    this.currentIndex = nextIndex
    this.refreshCurrentBars()
    return true
  }

  isFinished(): boolean {
    this.ensureInitialized()
    return this.currentIndex >= this.bars.length - 1
  }

  private refreshCurrentBars(): void {
    const ts = this.bars[this.currentIndex]?.ts
    const currentBars: BacktestBar[] = []
    const currentBarsBySymbol = new Map<string, BacktestBar>()

    for (let index = this.currentIndex; index < this.bars.length; index += 1) {
      const bar = this.bars[index]
      if (bar.ts !== ts) break
      currentBars.push(bar)
      currentBarsBySymbol.set(bar.symbol, bar)
    }

    this.currentBars = currentBars
    this.currentBarsBySymbol = currentBarsBySymbol
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('HistoricalMarketReplay not initialized')
    }
  }
}
