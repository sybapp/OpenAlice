import type { AccountManager, BacktestRunManager } from '../extension/trading/index.js'
import type { ITradingGit } from '../extension/trading/git/interfaces.js'
import type { CronEngine } from '../task/cron/engine.js'
import type { Heartbeat } from '../task/heartbeat/index.js'
import type { Config } from './config.js'
import type { ConnectorCenter } from './connector-center.js'
import type { Engine } from './engine.js'
import type { EventLog } from './event-log.js'
import type { ToolCenter } from './tool-center.js'

export type { Config }

export interface Plugin {
  name: string
  start(ctx: EngineContext): Promise<void>
  stop(): Promise<void>
}

export interface ReconnectResult {
  success: boolean
  error?: string
  message?: string
}

export interface BacktestBarsQuery {
  assetType: 'equity' | 'crypto'
  symbol: string
  startDate: string
  endDate: string
  interval?: string
}

export interface MarketDataBridge {
  getBacktestBars(query: BacktestBarsQuery): Promise<Array<{
    ts: string
    symbol: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>>
}

export interface EngineContext {
  config: Config
  connectorCenter: ConnectorCenter
  engine: Engine
  eventLog: EventLog
  heartbeat: Heartbeat
  cronEngine: CronEngine
  toolCenter: ToolCenter

  // Trading (unified account model)
  accountManager: AccountManager
  backtest: BacktestRunManager
  marketData: MarketDataBridge
  /** Get the TradingGit instance for an account by ID. */
  getAccountGit: (accountId: string) => ITradingGit | undefined
  /** Reconnect a specific trading account by ID. */
  reconnectAccount: (accountId: string) => Promise<ReconnectResult>
  /** Tear down the runtime state for a trading account by ID. */
  removeTradingAccountRuntime: (accountId: string) => Promise<void>
  /** Reconnect connector plugins (Telegram, MCP-Ask, etc.). */
  reconnectConnectors: () => Promise<ReconnectResult>
}

/** A media attachment collected from tool results (e.g. browser screenshots). */
export interface MediaAttachment {
  type: 'image'
  /** Absolute path to the file on disk. */
  path: string
}
