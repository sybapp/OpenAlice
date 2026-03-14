// ==================== Chat ====================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'notification'
  text: string
  timestamp?: string | null
}

export interface ChatResponse {
  text: string
  media: Array<{ type: 'image'; url: string }>
  requestId: string
}

export interface ToolCall {
  name: string
  input: string
  result?: string
}

export interface StreamingToolCall {
  id: string
  name: string
  input: string
  result?: string
  status: 'running' | 'done'
}

export type ChatStreamEvent =
  | {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
  | {
  type: 'tool_result'
  tool_use_id: string
  content: string
}
  | {
  type: 'text'
  text: string
}

export interface ChatStreamEnvelope {
  type: 'stream'
  requestId: string
  event: ChatStreamEvent
}

export type ChatHistoryItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; timestamp?: string; metadata?: Record<string, unknown>; media?: Array<{ type: string; url: string }> }
  | { kind: 'tool_calls'; calls: ToolCall[]; timestamp?: string }

// ==================== Capabilities ====================

export interface SystemToolInfo {
  name: string
  group: string
  description: string
}

export interface SkillCapabilityInfo {
  id: string
  label: string
  description: string
  runtime: 'tool-loop' | 'script-loop'
  userInvocable: boolean
  stage?: string
  resources: string[]
  allowedScripts: string[]
}

export interface ScriptCapabilityInfo {
  id: string
  description: string
  usedBy: string[]
}

export interface McpCapabilityInfo {
  id: string
  kind: 'system-tool' | 'skill'
  description: string
}

export interface CapabilityResponse {
  systemTools: SystemToolInfo[]
  skills: SkillCapabilityInfo[]
  scripts: ScriptCapabilityInfo[]
  mcpExposed: McpCapabilityInfo[]
  disabledSystemTools: string[]
}

// ==================== Config ====================

export interface AIProviderConfig {
  backend: string
  provider: string
  model: string
  baseUrl?: string
  apiKeys: { anthropic?: boolean; openai?: boolean; google?: boolean }
}

export interface AppConfig {
  aiProvider: AIProviderConfig
  engine: Record<string, unknown>
  agent: { evolutionMode: boolean; claudeCode: Record<string, unknown> }
  compaction: { maxContextTokens: number; maxOutputTokens: number }
  heartbeat: {
    enabled: boolean
    every: string
    prompt: string
    activeHours: { start: string; end: string; timezone: string } | null
  }
  connectors: ConnectorsConfig
  [key: string]: unknown
}

export interface ConfigUpdateResponse<T> {
  data: T
  meta?: {
    reconnectScheduled?: boolean
  }
}

export interface ConnectorsConfig {
  web: { host: string; port: number; hasAuthToken: boolean }
  mcp: { host: string; port: number }
  mcpAsk: { enabled: boolean; port?: number; hasAuthToken: boolean }
  telegram: {
    enabled: boolean
    hasBotToken: boolean
    botUsername?: string
    chatIds: number[]
  }
}

export interface OpenbbConfig {
  enabled: boolean
  providers: {
    equity: string
    crypto: string
    currency: string
    newsCompany: string
    newsWorld: string
  }
  providerKeys?: Record<string, boolean>
}

export interface UpdateConnectorsRequest {
  web?: {
    host?: string
    port?: number
    authToken?: string
    clearAuthToken?: boolean
  }
  mcp?: {
    host?: string
    port?: number
  }
  mcpAsk?: {
    enabled?: boolean
    port?: number
    authToken?: string
    clearAuthToken?: boolean
  }
  telegram?: {
    enabled?: boolean
    botToken?: string
    clearBotToken?: boolean
    botUsername?: string
    chatIds?: number[]
  }
}

// ==================== News Collector ====================

export interface NewsCollectorFeed {
  name: string
  url: string
  source: string
  categories?: string[]
}

export interface NewsCollectorConfig {
  enabled: boolean
  intervalMinutes: number
  maxInMemory: number
  retentionDays: number
  piggybackOpenBB: boolean
  feeds: NewsCollectorFeed[]
}

// ==================== Events ====================

export interface EventLogEntry {
  seq: number
  ts: number
  type: string
  payload: unknown
}

// ==================== Cron ====================

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string }

export interface CronJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: 'ok' | 'error' | null
  consecutiveErrors: number
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  payload: string
  state: CronJobState
  createdAt: number
}

export interface TraderJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: 'ok' | 'error' | null
  consecutiveErrors: number
}

export interface TraderStrategySummary {
  id: string
  label: string
  enabled: boolean
  sources: string[]
  asset: 'crypto' | 'equity'
  symbols: string[]
}

export interface TraderStrategyDetail extends TraderStrategySummary {
  timeframes: {
    context: string
    structure: string
    execution: string
  }
  riskBudget: {
    perTradeRiskPercent: number
    maxGrossExposurePercent: number
    maxPositions: number
    maxDailyLossPercent?: number
  }
  behaviorRules: {
    preferences: string[]
    prohibitions: string[]
  }
  executionPolicy: {
    allowedOrderTypes: Array<'market' | 'limit' | 'stop' | 'stop_limit' | 'take_profit'>
    requireProtection: boolean
    allowMarketOrders: boolean
    allowOvernight: boolean
  }
}

export interface TraderJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  strategyId: string
  state: TraderJobState
  createdAt: number
}

export interface TraderReviewJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  strategyId?: string
  state: TraderReviewJobState
  createdAt: number
}

export interface TraderReviewResult {
  updated: boolean
  summary: string
  strategyId?: string
}

export type TraderReviewJobState = TraderJobState

// ==================== Trading ====================

export interface TradingAccount {
  id: string
  provider: string
  label: string
}

export interface AccountInfo {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  portfolioValue?: number
  buyingPower?: number
  totalMargin?: number
  dayTradeCount?: number
}

export interface Position {
  contract: { aliceId?: string; symbol?: string; secType?: string; exchange?: string; currency?: string }
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  currentPrice: number
  marketValue: number
  unrealizedPnL: number
  unrealizedPnLPercent: number
  costBasis: number
  leverage: number
  margin?: number
  liquidationPrice?: number
}

export interface TradingCommitLog {
  hash: string
  message: string
  operations: Array<{ symbol: string; action: string; change: string; status: string }>
  timestamp: string
  round?: number
}

export interface ReconnectResult {
  success: boolean
  error?: string
  message?: string
}

// ==================== Trading Config ====================

export interface CcxtPlatformConfig {
  id: string
  label?: string
  type: 'ccxt'
  exchange: string
  sandbox: boolean
  demoTrading: boolean
  defaultMarketType: 'spot' | 'swap'
}

export interface AlpacaPlatformConfig {
  id: string
  label?: string
  type: 'alpaca'
  paper: boolean
}

export type PlatformConfig = CcxtPlatformConfig | AlpacaPlatformConfig

export interface TradingConfigAccount {
  id: string
  platformId: string
  label?: string
  hasApiKey: boolean
  hasApiSecret: boolean
  hasPassword: boolean
  guards: GuardEntry[]
}

export interface UpdateTradingAccountRequest {
  id: string
  platformId: string
  label?: string
  apiKey?: string | null
  apiSecret?: string | null
  password?: string | null
  guards: GuardEntry[]
}

export interface GuardEntry {
  type: string
  options: Record<string, unknown>
}

// ==================== Backtest ====================

export interface BacktestBar {
  ts: string
  symbol: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  bid?: number
  ask?: number
}

export type BacktestRunMode = 'scripted' | 'ai'
export type BacktestRunStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface BacktestDecisionPlanEntry {
  step: number
  operations: Array<{
    action: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder' | 'syncOrders'
    params: Record<string, unknown>
  }>
}

export interface ScriptedBacktestRunStrategyConfig {
  mode: 'scripted'
  decisions: BacktestDecisionPlanEntry[]
}

export interface AIBacktestRunStrategyConfig {
  mode: 'ai'
  prompt: string
  systemPrompt?: string
  maxHistoryEntries?: number
}

export type BacktestRunStrategyConfig =
  | ScriptedBacktestRunStrategyConfig
  | AIBacktestRunStrategyConfig

export interface BacktestStartRunRequest {
  runId?: string
  accountId?: string
  accountLabel?: string
  initialCash: number
  startTime?: string
  guards?: GuardEntry[]
  bars: BacktestBar[]
  strategy: BacktestRunStrategyConfig
}

export interface BacktestRunManifest {
  runId: string
  status: BacktestRunStatus
  mode: BacktestRunMode
  createdAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  sessionId?: string
  artifactDir: string
  barCount: number
  currentStep: number
  accountId: string
  accountLabel: string
  initialCash: number
  startTime?: string
  guards: GuardEntry[]
}

export interface BacktestRunSummary {
  runId: string
  startEquity: number
  endEquity: number
  totalReturn: number
  realizedPnL: number
  unrealizedPnL: number
  maxDrawdown: number
  tradeCount: number
  winRate: number
  guardRejectionCount: number
}

export interface BacktestRunRecord {
  manifest: BacktestRunManifest
  summary?: BacktestRunSummary
}

export interface BacktestEquityPoint {
  step: number
  ts: string
  equity: number
  realizedPnL: number
  unrealizedPnL: number
}

export interface BacktestEventEntry {
  seq: number
  ts: number
  type: string
  payload: unknown
}

export interface BacktestBarsQuery {
  assetType: 'equity' | 'crypto'
  symbol: string
  startDate: string
  endDate: string
  interval?: string
}

export interface BacktestFetchBarsResponse {
  bars: BacktestBar[]
}

export interface BacktestGitState {
  head: string | null
  commits: Array<{
    hash: string
    parentHash: string | null
    message: string
    operations: Array<{ action: string; params: Record<string, unknown> }>
    results: Array<{
      action: string
      success: boolean
      orderId?: string
      status: string
      filledPrice?: number
      filledQty?: number
      error?: string
      raw?: unknown
    }>
    stateAfter: {
      cash: number
      equity: number
      unrealizedPnL: number
      realizedPnL: number
      positions: unknown[]
      pendingOrders: unknown[]
    }
    timestamp: string
    round?: number
  }>
}

export interface SessionEntry {
  type: 'user' | 'assistant' | 'meta' | 'system'
  message: {
    role: 'user' | 'assistant' | 'system'
    content: string | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; url: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
      | { type: 'tool_result'; tool_use_id: string; content: string }
    >
  }
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string
  provider?: 'engine' | 'claude-code' | 'codex-cli' | 'human' | 'compaction'
  cwd?: string
  metadata?: Record<string, unknown>
  subtype?: 'compact_boundary'
  compactMetadata?: { trigger: 'auto' | 'manual'; preTokens: number }
  isCompactSummary?: boolean
}
