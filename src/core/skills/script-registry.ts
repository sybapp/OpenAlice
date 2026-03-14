import type { Tool } from 'ai'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { EventLog } from '../event-log.js'
import type { ToolCenter } from '../tool-center.js'
import type { Brain } from '../../extension/cognition/brain/index.js'
import type { AccountManager } from '../../extension/trading/index.js'
import type { ITradingGit } from '../../extension/trading/index.js'
import type { MarketDataBridge } from '../types.js'
import { analyzeBrooksPa } from '../../extension/technical-analysis/brooks-pa/analyzer/index.js'
import { buildBrooksCoreFromDetailed } from '../../extension/technical-analysis/brooks-pa/analyzer/core.js'
import type { Timeframes } from '../../extension/technical-analysis/brooks-pa/types.js'
import { analyzeIctSmc } from '../../extension/technical-analysis/ict-smc/analyze.js'
import { IndicatorCalculator } from '../../extension/technical-analysis/indicator-kit/index.js'
import type { OhlcvData } from '../../extension/technical-analysis/indicator-kit/index.js'

export interface SkillScriptContext {
  config: Config
  eventLog: EventLog
  toolCenter: ToolCenter
  brain: Brain
  accountManager: AccountManager
  marketData: MarketDataBridge
  getAccountGit: (accountId: string) => ITradingGit | undefined
  invocation: Record<string, unknown>
}

export interface SkillScriptModule<TInput = unknown, TOutput = unknown> {
  id: string
  description: string
  inputSchema: z.ZodType<TInput>
  outputSchema?: z.ZodType<TOutput>
  run: (ctx: SkillScriptContext, input: TInput) => Promise<TOutput>
}

interface BacktestScriptInvocation {
  mode?: 'backtest'
  asset?: 'equity' | 'crypto' | 'currency'
  source?: string
  currentTimestamp?: string
  bars?: Array<{
    ts: string
    symbol: string
    open: number
    high: number
    low: number
    close: number
    volume: number
    bid?: number
    ask?: number
  }>
  account?: unknown
  positions?: unknown[]
  orders?: unknown[]
  marketClock?: unknown
}

async function getScriptTool(ctx: SkillScriptContext, scriptId: string, toolName: string): Promise<Tool> {
  const tools = await ctx.toolCenter.getVercelTools({ allow: [toolName] })
  const tool = tools[toolName] as Tool | undefined
  if (!tool?.execute) {
    throw new Error(`Tool unavailable for script ${scriptId}: ${toolName}`)
  }
  return tool
}

async function executeToolScript<TInput extends Record<string, unknown>>(
  ctx: SkillScriptContext,
  scriptId: string,
  toolName: string,
  input: TInput,
) {
  const tool = await getScriptTool(ctx, scriptId, toolName)
  return tool.execute(input, { toolCallId: `script:${scriptId}`, messages: [] })
}

function createToolBackedScript<TInput extends Record<string, unknown>>(params: {
  id: string
  description: string
  inputSchema: z.ZodType<TInput>
  toolName: string
}): SkillScriptModule<TInput, unknown> {
  return {
    id: params.id,
    description: params.description,
    inputSchema: params.inputSchema,
    async run(ctx, input) {
      return executeToolScript(ctx, params.id, params.toolName, input)
    },
  }
}

function getBacktestInvocation(ctx: SkillScriptContext): BacktestScriptInvocation | null {
  const candidate = ctx.invocation.backtest
  if (!candidate || typeof candidate !== 'object') return null
  return candidate as BacktestScriptInvocation
}

function toOhlcvData(bar: {
  ts: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}): OhlcvData {
  return {
    date: bar.ts,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }
}

function getBacktestBars(ctx: SkillScriptContext, symbol: string, lookbackBars?: number): OhlcvData[] | null {
  const backtest = getBacktestInvocation(ctx)
  if (!backtest?.bars?.length || !backtest.currentTimestamp) return null

  const history = backtest.bars
    .filter((bar) => bar.symbol === symbol && bar.ts <= backtest.currentTimestamp!)
    .map(toOhlcvData)

  if (history.length === 0) return []
  if (!lookbackBars || history.length <= lookbackBars) return history
  return history.slice(-lookbackBars)
}

async function buildTraderAccountSnapshot(ctx: SkillScriptContext, source: string) {
  const backtest = getBacktestInvocation(ctx)
  if (backtest?.source === source) {
    return {
      source,
      account: backtest.account ?? null,
      positions: backtest.positions ?? [],
      orders: backtest.orders ?? [],
      marketClock: backtest.marketClock,
    }
  }

  const account = ctx.accountManager.getAccount(source)
  if (!account) {
    throw new Error(`Configured source not available: ${source}`)
  }

  const [accountInfo, positions, orders, marketClock] = await Promise.all([
    account.getAccount(),
    account.getPositions(),
    account.getOrders(),
    account.getMarketClock().catch(() => undefined),
  ])

  return {
    source,
    account: accountInfo,
    positions,
    orders,
    marketClock,
  }
}

const scripts = [
  createToolBackedScript({
    id: 'research-market-search',
    description: 'Search symbols across equity, crypto, and currency before running analysis.',
    toolName: 'marketSearchForResearch',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
  }),
  {
    id: 'analysis-brooks',
    description: 'Run deterministic Brooks-style price action analysis.',
    inputSchema: z.object({
      asset: z.enum(['equity', 'crypto', 'currency']),
      symbol: z.string().min(1),
      timeframes: z.object({
        context: z.string().optional(),
        structure: z.string().optional(),
        execution: z.string().optional(),
      }).optional(),
      lookbackBars: z.number().int().positive().optional(),
      recentBars: z.number().int().positive().optional(),
      midpointAvoidance: z.object({
        enabled: z.boolean().optional(),
        band: z.number().min(0).max(0.5).optional(),
      }).optional(),
      detailLevel: z.enum(['core', 'full']).optional(),
      dropUnclosed: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const backtestBars = getBacktestBars(ctx, input.symbol, input.lookbackBars ?? 300)
      if (!backtestBars) {
        return executeToolScript(ctx, 'analysis-brooks', 'brooksPaAnalyze', input)
      }

      const timeframes: Timeframes = {
        context: input.timeframes?.context ?? '1h',
        structure: input.timeframes?.structure ?? '15m',
        execution: input.timeframes?.execution ?? '5m',
      }
      const lookbackBars = input.lookbackBars ?? 300
      const recentBars = input.recentBars ?? 10
      const midpointAvoidance = {
        enabled: input.midpointAvoidance?.enabled ?? true,
        band: input.midpointAvoidance?.band ?? 0.4,
      }

      const detailed = analyzeBrooksPa({
        symbol: input.symbol,
        timeframes,
        lookbackBars,
        recentBars,
        midpointAvoidance,
        dataByTf: {
          [timeframes.context]: backtestBars,
          [timeframes.structure]: backtestBars,
          [timeframes.execution]: backtestBars,
        },
      })
      const core = buildBrooksCoreFromDetailed(detailed, { symbol: input.symbol, timeframes })
      const base = {
        version: 2 as const,
        symbol: input.symbol,
        timeframes,
        lookbackBars,
        recentBars,
        core,
      }
      return (input.detailLevel ?? 'full') === 'core'
        ? base
        : { ...base, detailed }
    },
  },
  {
    id: 'analysis-ict-smc',
    description: 'Run deterministic ICT/SMC structure analysis.',
    inputSchema: z.object({
      asset: z.enum(['equity', 'crypto', 'currency']),
      symbol: z.string().min(1),
      timeframe: z.string().optional(),
      lookbackBars: z.number().int().positive().optional(),
      recentBars: z.number().int().positive().optional(),
      swingLookback: z.number().int().positive().optional(),
      detailLevel: z.enum(['core', 'full']).optional(),
      dropUnclosed: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const backtestBars = getBacktestBars(ctx, input.symbol, input.lookbackBars ?? 300)
      if (!backtestBars) {
        return executeToolScript(ctx, 'analysis-ict-smc', 'ictSmcAnalyze', input)
      }

      const timeframe = input.timeframe ?? '5m'
      const lookbackBars = input.lookbackBars ?? 300
      const recentBars = input.recentBars ?? 10
      const swingLookback = input.swingLookback ?? 2
      const output = analyzeIctSmc({
        symbol: input.symbol,
        timeframe,
        lookbackBars,
        recentBars,
        swingLookback,
        bars: backtestBars,
      })

      return (input.detailLevel ?? 'full') === 'core'
        ? {
            version: output.version,
            symbol: output.symbol,
            timeframe: output.timeframe,
            lookbackBars: output.lookbackBars,
            recentBars: output.recentBars,
            core: output.core,
          }
        : output
    },
  },
  {
    id: 'analysis-indicator',
    description: 'Calculate a technical indicator formula for a symbol.',
    inputSchema: z.object({
      asset: z.enum(['equity', 'crypto', 'currency']),
      formula: z.string().min(1),
      precision: z.number().int().min(0).max(10).optional(),
      dropUnclosed: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const backtest = getBacktestInvocation(ctx)
      if (!backtest?.bars?.length) {
        return executeToolScript(ctx, 'analysis-indicator', 'calculateIndicator', input)
      }

      const calculator = new IndicatorCalculator({
        getHistoricalData: async (symbol) => getBacktestBars(ctx, symbol, undefined) ?? [],
      })
      return calculator.calculate(input.formula, input.precision)
    },
  },
  createToolBackedScript({
    id: 'research-news-company',
    description: 'Load recent company-specific news.',
    toolName: 'newsGetCompany',
    inputSchema: z.object({
      symbol: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
  }),
  createToolBackedScript({
    id: 'research-news-world',
    description: 'Load recent world or macro news.',
    toolName: 'newsGetWorld',
    inputSchema: z.object({
      limit: z.number().int().positive().optional(),
    }),
  }),
  createToolBackedScript({
    id: 'research-equity-profile',
    description: 'Load company profile and key metrics.',
    toolName: 'equityGetProfile',
    inputSchema: z.object({
      symbol: z.string().min(1),
    }),
  }),
  createToolBackedScript({
    id: 'research-equity-financials',
    description: 'Load company financial statements.',
    toolName: 'equityGetFinancials',
    inputSchema: z.object({
      symbol: z.string().min(1),
      type: z.enum(['income', 'balance', 'cash']),
      period: z.enum(['annual', 'quarter']).optional(),
      limit: z.number().int().positive().optional(),
    }),
  }),
  createToolBackedScript({
    id: 'research-equity-ratios',
    description: 'Load company financial ratios.',
    toolName: 'equityGetRatios',
    inputSchema: z.object({
      symbol: z.string().min(1),
      period: z.enum(['annual', 'quarter']).optional(),
      limit: z.number().int().positive().optional(),
    }),
  }),
  createToolBackedScript({
    id: 'research-equity-estimates',
    description: 'Load analyst estimate consensus for a company.',
    toolName: 'equityGetEstimates',
    inputSchema: z.object({
      symbol: z.string().min(1),
    }),
  }),
  {
    id: 'trader-account-state',
    description: 'Load fresh account, position, order, and market clock state for a configured source.',
    inputSchema: z.object({
      source: z.string().min(1),
    }),
    async run(ctx, input) {
      return buildTraderAccountSnapshot(ctx, input.source)
    },
  },
  {
    id: 'trader-review-summaries',
    description: 'Summarize recent trading history and stats for one or more account sources.',
    inputSchema: z.object({
      sources: z.array(z.string().min(1)).min(1),
      limit: z.number().int().positive().default(50),
    }),
    async run(ctx, input) {
      return input.sources.map((source) => {
        const git = ctx.getAccountGit(source)
        if (!git) {
          return { source, summary: 'No trading history available.' }
        }
        const commits = git.log({ limit: input.limit })
        return {
          source,
          totalCommits: commits.length,
          latestCommit: commits[0]?.hash ?? null,
          latestMessage: commits[0]?.message ?? null,
        }
      })
    },
  },
  {
    id: 'trader-execute-plan',
    description: 'Deterministically execute a staged trade plan via placeOrder -> tradingCommit -> tradingPush.',
    inputSchema: z.object({
      source: z.string().min(1),
      commitMessage: z.string().min(1),
      orders: z.array(z.object({
        aliceId: z.string().min(1),
        symbol: z.string().min(1),
        side: z.enum(['buy', 'sell']),
        type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'take_profit', 'trailing_stop', 'trailing_stop_limit', 'moc']),
        qty: z.number().positive().optional(),
        notional: z.number().positive().optional(),
        price: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trailingAmount: z.number().positive().optional(),
        trailingPercent: z.number().positive().optional(),
        reduceOnly: z.boolean().optional(),
        timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok', 'opg', 'gtd']).default('day'),
        goodTillDate: z.string().optional(),
        extendedHours: z.boolean().optional(),
        parentId: z.string().optional(),
        ocaGroup: z.string().optional(),
        protection: z.object({
          stopLossPct: z.number().positive().optional(),
          takeProfitPct: z.number().positive().optional(),
          stopLossPrice: z.number().positive().optional(),
          takeProfitPrice: z.number().positive().optional(),
          takeProfitSizeRatio: z.number().positive().max(1).optional(),
        }).optional(),
      })).min(1),
    }),
    async run(ctx, input) {
      const placeOrder = (await ctx.toolCenter.getVercelTools({ allow: ['placeOrder'] })).placeOrder
      const tradingCommit = (await ctx.toolCenter.getVercelTools({ allow: ['tradingCommit'] })).tradingCommit
      const tradingPush = (await ctx.toolCenter.getVercelTools({ allow: ['tradingPush'] })).tradingPush
      if (!placeOrder?.execute || !tradingCommit?.execute || !tradingPush?.execute) {
        throw new Error('Trading execution tools are unavailable')
      }

      const staged: unknown[] = []
      for (const order of input.orders) {
        staged.push(await placeOrder.execute({ source: input.source, ...order }, { toolCallId: 'script:placeOrder', messages: [] }))
      }

      const commit = await tradingCommit.execute({
        source: input.source,
        message: input.commitMessage,
      }, { toolCallId: 'script:tradingCommit', messages: [] })

      const pushed = await tradingPush.execute({
        source: input.source,
        mode: 'best-effort',
      }, { toolCallId: 'script:tradingPush', messages: [] })

      return { staged, commit, pushed }
    },
  },
] satisfies SkillScriptModule[]

const scriptMap = new Map(scripts.map((script) => [script.id, script]))

export function getSkillScript(id: string): SkillScriptModule | null {
  return scriptMap.get(id) ?? null
}

export function listSkillScripts(ids?: string[]): SkillScriptModule[] {
  if (!ids?.length) return [...scriptMap.values()]
  return ids
    .map((id) => scriptMap.get(id))
    .filter((script): script is SkillScriptModule => Boolean(script))
}
