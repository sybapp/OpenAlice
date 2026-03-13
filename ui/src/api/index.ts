/**
 * Unified API client — re-exports domain modules as the `api` namespace.
 * Existing imports like `import { api } from '../api'` continue to work.
 */
import { chatApi as chat } from './chat'
import { configApi as config } from './config'
import { authApi as auth } from './auth'
import { eventsApi as events } from './events'
import { cronApi as cron } from './cron'
import { heartbeatApi as heartbeat } from './heartbeat'
import { tradingApi as trading } from './trading'
import { backtestApi as backtest } from './backtest'
import { openbbApi as openbb } from './openbb'
import { devApi as dev } from './dev'
import { toolsApi as tools } from './tools'

export const api = {
  auth,
  chat,
  config,
  events,
  cron,
  heartbeat,
  trading,
  backtest,
  openbb,
  dev,
  tools,
}

// Re-export all types for convenience
export type {
  ChatMessage,
  ChatResponse,
  ToolCall,
  StreamingToolCall,
  ChatStreamEvent,
  ChatStreamEnvelope,
  ChatHistoryItem,
  AppConfig,
  AIProviderConfig,
  EventLogEntry,
  CronSchedule,
  CronJobState,
  CronJob,
  TradingAccount,
  AccountInfo,
  Position,
  WalletCommitLog,
  ReconnectResult,
  BacktestBar,
  BacktestRunMode,
  BacktestRunStatus,
  BacktestDecisionPlanEntry,
  BacktestRunManifest,
  BacktestRunSummary,
  BacktestRunRecord,
  BacktestEquityPoint,
  BacktestEventEntry,
  BacktestBarsQuery,
  BacktestFetchBarsResponse,
  BacktestStartRunRequest,
  BacktestGitState,
  SessionEntry,
  ConnectorsConfig,
  OpenbbConfig,
  ConfigUpdateResponse,
  UpdateConnectorsRequest,
  TradingConfigAccount,
  UpdateTradingAccountRequest,
  NewsCollectorConfig,
  NewsCollectorFeed,
} from './types'
export type { EventQueryResult } from './events'
