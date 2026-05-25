import type { QueryExecutor } from '@traderalice/opentypebb'
import type { UTAManagerSDK } from '../services/uta-client/index.js'
import type { INewsProvider } from '../domain/news/types.js'
import type { MarketSearchDeps } from '../domain/market-data/aggregate-search.js'
import type { MarketDataAlertRunResult, MarketDataWatchRunResult } from '../domain/market-data/ohlcv/index.js'
import type { SignalEngineService } from '../domain/signal-engine/index.js'
import type { TradeSetupService } from '../domain/trading/setup-service.js'
import type { TradeSetupStore } from '../domain/trading/setup-store.js'
import type { CronEngine } from '../task/cron/engine.js'
import type { Heartbeat } from '../task/heartbeat/index.js'
import type { Config, WebChannel } from './config.js'
import type { ConnectorCenter } from './connector-center.js'
import type { AgentCenter } from './agent-center.js'
import type { EventLog } from './event-log.js'
import type { ToolCallLog } from './tool-call-log.js'
import type { ToolCenter } from './tool-center.js'
import type { ListenerRegistry } from './listener-registry.js'
import type { EventBus } from './event-bus.js'
import type { INotificationsStore } from './notifications-store.js'
import type { IInboxStore } from './inbox-store.js'

export type { Config, WebChannel }

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

export interface EngineContext {
  config: Config
  connectorCenter: ConnectorCenter
  /** Canonical store of system notifications; connectors subscribe via onAppended. */
  notificationsStore: INotificationsStore
  /** Workspace-anchored push surface (Linear-inbox style). v0: read path
   *  wired, production write path deliberately deferred — only dev seed
   *  endpoint exists until the workspace integration pathway is decided. */
  inboxStore: IInboxStore
  agentCenter: AgentCenter
  eventLog: EventLog
  toolCallLog: ToolCallLog
  heartbeat: Heartbeat
  cronEngine: CronEngine
  toolCenter: ToolCenter
  listenerRegistry: ListenerRegistry
  /** Ergonomic in-process producer facade. Use this to fire events from
   *  plugins / hacks / extension code instead of plumbing eventLog. */
  fire: EventBus

  // Market data
  bbEngine: QueryExecutor
  /** Deps for cross-asset-class heuristic symbol search. Shared between the
   *  AI tool (marketSearchForResearch) and the /api/market/search HTTP route. */
  marketSearch: MarketSearchDeps
  runMarketDataWatchNow?: () => Promise<MarketDataWatchRunResult>
  runMarketDataAlertsNow?: () => Promise<MarketDataAlertRunResult>
  signalEngineService?: SignalEngineService
  tradeSetupStore?: TradeSetupStore
  tradeSetupService?: TradeSetupService

  // Trading — HTTP-backed SDK that talks to the co-located UTA service.
  // FxService and SnapshotService live entirely inside UTA after Step 6;
  // anything Alice used to read off `ctx.fxService` / `ctx.snapshotService`
  // now goes through the SDK (e.g. `await utaManager.getAggregatedEquity()`
  // for FX-converted totals).
  utaManager: UTAManagerSDK
  newsProvider?: INewsProvider
  /** Reconnect connector plugins (Telegram, MCP-Ask, etc.). */
  reconnectConnectors: () => Promise<ReconnectResult>
}

/** A media attachment collected from tool results (e.g. browser screenshots). */
export interface MediaAttachment {
  type: 'image'
  /** Absolute path to the file on disk. */
  path: string
}
