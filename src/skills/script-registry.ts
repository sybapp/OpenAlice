import { z } from 'zod'
import type { Config } from '../core/config.js'
import type { EventLog } from '../core/event-log.js'
import type { Brain } from '../domains/cognition/brain/index.js'
import type { AccountManager } from '../domains/trading/index.js'
import type { ITradingGit } from '../domains/trading/index.js'
import type { MarketDataBridge } from '../core/types.js'
import type { INewsProvider } from '../domains/research/news-collector/types.js'
import { analyzeBrooksPa } from '../domains/technical-analysis/brooks-pa/analyzer/index.js'
import { buildBrooksCoreFromDetailed } from '../domains/technical-analysis/brooks-pa/analyzer/core.js'
import type { Timeframes } from '../domains/technical-analysis/brooks-pa/types.js'
import { analyzeIctSmc } from '../domains/technical-analysis/ict-smc/analyze.js'
import { IndicatorCalculator, getCalendarDaysForInterval } from '../domains/technical-analysis/indicator-kit/index.js'
import type { OhlcvData } from '../domains/technical-analysis/indicator-kit/index.js'
import type { OhlcvStore } from '../domains/technical-analysis/indicator-kit/index.js'
import type { NewsItem } from '../domains/research/news-collector/types.js'
import { globNews, grepNews, readNews } from '../domains/research/news-collector/tools.js'
import {
  presentSourceAlias,
  readHiddenSourceAliases,
  resolveSourceAlias,
} from '../core/source-alias.js'

export interface SkillScriptContext {
  config: Config
  eventLog: EventLog
  brain: Brain
  accountManager: AccountManager
  marketData: MarketDataBridge
  ohlcvStore: OhlcvStore
  newsStore: INewsProvider
  getAccountGit: (accountId: string) => ITradingGit | undefined
  invocation: Record<string, unknown>
}

export interface SkillScriptModule<TInput = unknown, TOutput = unknown> {
  id: string
  description: string
  inputSchema: z.ZodType<TInput>
  inputGuide?: string
  outputSchema?: z.ZodType<TOutput>
  run: (ctx: SkillScriptContext, input: TInput) => Promise<TOutput>
}

export type AnySkillScriptModule = SkillScriptModule<any, any>

function defineScript<TInput, TOutput>(
  script: SkillScriptModule<TInput, TOutput>,
): SkillScriptModule<TInput, TOutput> {
  return script
}

interface BacktestScriptInvocation {
  mode?: 'backtest'
  asset?: 'crypto'
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

function getBacktestInvocation(ctx: SkillScriptContext): BacktestScriptInvocation | null {
  const candidate = ctx.invocation.backtest
  if (!candidate || typeof candidate !== 'object') return null
  return candidate as BacktestScriptInvocation
}

function getSourceAliases(ctx: SkillScriptContext) {
  return readHiddenSourceAliases(ctx.invocation)
}

function resolveTraderSource(ctx: SkillScriptContext, source: string): string {
  return resolveSourceAlias(getSourceAliases(ctx), source)
}

function presentTraderSource(ctx: SkillScriptContext, source: string): string {
  return presentSourceAlias(getSourceAliases(ctx), source)
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

function getBrooksSettings(input: {
  timeframes?: {
    context?: string
    structure?: string
    execution?: string
  }
  lookbackBars?: number
  recentBars?: number
  midpointAvoidance?: {
    enabled?: boolean
    band?: number
  }
}) {
  return {
    timeframes: {
      context: input.timeframes?.context ?? '1h',
      structure: input.timeframes?.structure ?? '15m',
      execution: input.timeframes?.execution ?? '5m',
    } satisfies Timeframes,
    lookbackBars: input.lookbackBars ?? 300,
    recentBars: input.recentBars ?? 10,
    midpointAvoidance: {
      enabled: input.midpointAvoidance?.enabled ?? true,
      band: input.midpointAvoidance?.band ?? 0.4,
    },
  }
}

function formatBrooksResult(
  symbol: string,
  timeframes: Timeframes,
  lookbackBars: number,
  recentBars: number,
  detailLevel: 'core' | 'full',
  detailed: ReturnType<typeof analyzeBrooksPa>,
) {
  const core = buildBrooksCoreFromDetailed(detailed, { symbol, timeframes })
  const base = {
    version: 2 as const,
    symbol,
    timeframes,
    lookbackBars,
    recentBars,
    core,
  }
  return detailLevel === 'core' ? base : { ...base, detailed }
}

function getIctSettings(input: {
  timeframe?: string
  lookbackBars?: number
  recentBars?: number
  swingLookback?: number
}) {
  return {
    timeframe: input.timeframe ?? '5m',
    lookbackBars: input.lookbackBars ?? 300,
    recentBars: input.recentBars ?? 10,
    swingLookback: input.swingLookback ?? 2,
  }
}

function formatIctResult(
  detailLevel: 'core' | 'full',
  output: ReturnType<typeof analyzeIctSmc>,
) {
  return detailLevel === 'core'
    ? {
        version: output.version,
        symbol: output.symbol,
        timeframe: output.timeframe,
        lookbackBars: output.lookbackBars,
        recentBars: output.recentBars,
        core: output.core,
      }
    : output
}

async function buildTraderAccountSnapshot(ctx: SkillScriptContext, source: string) {
  const resolvedSource = resolveTraderSource(ctx, source)
  const backtest = getBacktestInvocation(ctx)
  if (backtest?.source === resolvedSource) {
    return {
      source: presentTraderSource(ctx, resolvedSource),
      account: backtest.account ?? null,
      positions: backtest.positions ?? [],
      orders: backtest.orders ?? [],
      marketClock: backtest.marketClock,
    }
  }

  const account = ctx.accountManager.getAccount(resolvedSource)
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
    source: presentTraderSource(ctx, resolvedSource),
    account: accountInfo,
    positions,
    orders,
    marketClock,
  }
}

async function searchMarket(ctx: SkillScriptContext, query: string, limit: number = 20) {
  const matches = await ctx.accountManager.searchContracts(query)
  const results = matches
    .flatMap((match) => match.results.map((item) => ({
      assetClass: 'crypto' as const,
      source: presentTraderSource(ctx, match.accountId),
      aliceId: item.contract.aliceId,
      symbol: item.contract.localSymbol ?? item.contract.symbol,
      exchange: item.contract.exchange,
      currency: item.contract.currency,
      description: item.contract.description,
    })))
    .slice(0, limit)

  if (results.length === 0) {
    return { results: [], message: `No symbols matching "${query}". Try a different keyword.` }
  }
  return { results, count: results.length }
}

function createNewsArchiveReader(ctx: SkillScriptContext, lookback?: string) {
  return {
    getNews: () => ctx.newsStore.getNewsV2({ endTime: new Date(), lookback, limit: 500 }),
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

function newsMatchesSymbol(item: NewsItem, symbol: string): boolean {
  if (item.metadata.symbol && item.metadata.symbol.toUpperCase() === symbol) return true
  const text = `${item.title}\n${item.content}`.toUpperCase()
  return text.includes(symbol)
}

async function getArchiveNews(
  ctx: SkillScriptContext,
  options: { lookback?: string; limit?: number; source?: string; symbol?: string },
) {
  const cap = options.limit ?? 20
  const news = await ctx.newsStore.getNewsV2({ endTime: new Date(), lookback: options.lookback, limit: 500 })
  const sourceFilter = options.source?.trim().toLowerCase()
  const symbolFilter = options.symbol ? normalizeSymbol(options.symbol) : undefined
  const filtered = news.filter((item) => {
    if (sourceFilter && String(item.metadata.source ?? '').toLowerCase() !== sourceFilter) return false
    if (symbolFilter && !newsMatchesSymbol(item, symbolFilter)) return false
    return true
  })
  const sliced = filtered.slice(-cap)
  return sliced.map((item) => ({
    time: item.time.toISOString(),
    title: item.title,
    content: item.content,
    metadata: item.metadata,
  }))
}

const cryptoAssetSchema = z.literal('crypto').default('crypto')

const brooksTimeframesSchema = z.object({
  context: z.string().optional(),
  structure: z.string().optional(),
  execution: z.string().optional(),
}).optional()

const scripts: AnySkillScriptModule[] = [
  defineScript({
    id: 'research-market-search',
    description: 'Search crypto symbols across configured CCXT accounts before running analysis.',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      return searchMarket(ctx, input.query, input.limit)
    },
  }),
  defineScript({
    id: 'analysis-brooks',
    description: 'Run deterministic Brooks-style price action analysis.',
    inputGuide: 'Use an object like {"asset":"crypto","symbol":"BTC/USDT:USDT","timeframes":{"context":"1h","structure":"15m","execution":"5m"}}. timeframes must be a named object, never an array.',
    inputSchema: z.object({
      asset: cryptoAssetSchema,
      symbol: z.string().min(1),
      timeframes: brooksTimeframesSchema,
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
      const detailLevel = input.detailLevel ?? 'full'
      const { timeframes, lookbackBars, recentBars, midpointAvoidance } = getBrooksSettings(input)
      const backtestBars = getBacktestBars(ctx, input.symbol, lookbackBars)

      if (!backtestBars) {
        const [ctxBars, strBars, exeBars] = await Promise.all([
          ctx.ohlcvStore.fetch({
            asset: input.asset,
            symbol: input.symbol,
            interval: timeframes.context,
            strategy: 'bars',
            lookbackBars,
            dropUnclosed: input.dropUnclosed,
          }),
          ctx.ohlcvStore.fetch({
            asset: input.asset,
            symbol: input.symbol,
            interval: timeframes.structure,
            strategy: 'bars',
            lookbackBars,
            dropUnclosed: input.dropUnclosed,
          }),
          ctx.ohlcvStore.fetch({
            asset: input.asset,
            symbol: input.symbol,
            interval: timeframes.execution,
            strategy: 'bars',
            lookbackBars,
            dropUnclosed: input.dropUnclosed,
          }),
        ])

        const detailed = analyzeBrooksPa({
          symbol: input.symbol,
          timeframes,
          lookbackBars,
          recentBars,
          midpointAvoidance,
          dataByTf: {
            [timeframes.context]: ctxBars,
            [timeframes.structure]: strBars,
            [timeframes.execution]: exeBars,
            },
          })
        return formatBrooksResult(input.symbol, timeframes, lookbackBars, recentBars, detailLevel, detailed)
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
      return formatBrooksResult(input.symbol, timeframes, lookbackBars, recentBars, detailLevel, detailed)
    },
  }),
  defineScript({
    id: 'analysis-ict-smc',
    description: 'Run deterministic ICT/SMC structure analysis.',
    inputGuide: 'Use an object like {"asset":"crypto","symbol":"BTC/USDT:USDT","timeframe":"15m"}. asset must stay the literal string "crypto".',
    inputSchema: z.object({
      asset: cryptoAssetSchema,
      symbol: z.string().min(1),
      timeframe: z.string().optional(),
      lookbackBars: z.number().int().positive().optional(),
      recentBars: z.number().int().positive().optional(),
      swingLookback: z.number().int().positive().optional(),
      detailLevel: z.enum(['core', 'full']).optional(),
      dropUnclosed: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const detailLevel = input.detailLevel ?? 'full'
      const { timeframe, lookbackBars, recentBars, swingLookback } = getIctSettings(input)
      const backtestBars = getBacktestBars(ctx, input.symbol, lookbackBars)

      if (!backtestBars) {
        const bars = await ctx.ohlcvStore.fetch({
          asset: input.asset,
          symbol: input.symbol,
          interval: timeframe,
          strategy: 'bars',
          lookbackBars,
          dropUnclosed: input.dropUnclosed,
        })
        const output = analyzeIctSmc({
          symbol: input.symbol,
          timeframe,
          lookbackBars,
          recentBars,
          swingLookback,
          bars,
        })
        return formatIctResult(detailLevel, output)
      }

      const output = analyzeIctSmc({
        symbol: input.symbol,
        timeframe,
        lookbackBars,
        recentBars,
        swingLookback,
        bars: backtestBars,
      })

      return formatIctResult(detailLevel, output)
    },
  }),
  defineScript({
    id: 'analysis-indicator',
    description: 'Calculate a technical indicator formula for a symbol.',
    inputGuide: 'Use an object like {"asset":"crypto","formula":"close(\"BTC/USDT:USDT\", \"5m\")"}. asset must stay the literal string "crypto".',
    inputSchema: z.object({
      asset: cryptoAssetSchema,
      formula: z.string().min(1),
      precision: z.number().int().min(0).max(10).optional(),
      dropUnclosed: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const backtest = getBacktestInvocation(ctx)
      if (!backtest?.bars?.length) {
        const calculator = new IndicatorCalculator({
          getHistoricalData: (symbol, interval) =>
            ctx.ohlcvStore.fetch({
              asset: input.asset,
              symbol,
              interval,
              strategy: 'calendar',
              calendarDays: getCalendarDaysForInterval(interval),
              dropUnclosed: input.dropUnclosed,
            }),
        })
        return calculator.calculate(input.formula, input.precision)
      }

      const calculator = new IndicatorCalculator({
        getHistoricalData: async (symbol) => getBacktestBars(ctx, symbol, undefined) ?? [],
      })
      return calculator.calculate(input.formula, input.precision)
    },
  }),
  defineScript({
    id: 'research-news-company',
    description: 'Load recent symbol-specific news from the collected news archive.',
    inputSchema: z.object({
      symbol: z.string().min(1),
      lookback: z.string().optional(),
      source: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      const symbol = normalizeSymbol(input.symbol)
      const items = await getArchiveNews(ctx, {
        symbol,
        lookback: input.lookback,
        source: input.source,
        limit: input.limit,
      })
      return {
        symbol,
        count: items.length,
        items,
      }
    },
  }),
  defineScript({
    id: 'research-news-world',
    description: 'Load recent world/macro news from the collected news archive.',
    inputSchema: z.object({
      lookback: z.string().optional(),
      source: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      const items = await getArchiveNews(ctx, {
        lookback: input.lookback,
        source: input.source,
        limit: input.limit,
      })
      return {
        count: items.length,
        items,
      }
    },
  }),
  defineScript({
    id: 'research-news-archive-glob',
    description: 'Search archived news headlines by regex pattern.',
    inputSchema: z.object({
      pattern: z.string().min(1),
      lookback: z.string().optional(),
      metadataFilter: z.record(z.string(), z.string()).optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      return globNews(createNewsArchiveReader(ctx, input.lookback), input)
    },
  }),
  defineScript({
    id: 'research-news-archive-grep',
    description: 'Search archived news content by regex pattern.',
    inputSchema: z.object({
      pattern: z.string().min(1),
      lookback: z.string().optional(),
      contextChars: z.number().int().positive().optional(),
      metadataFilter: z.record(z.string(), z.string()).optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      return grepNews(createNewsArchiveReader(ctx, input.lookback), input)
    },
  }),
  defineScript({
    id: 'research-news-archive-read',
    description: 'Read one archived news item by index.',
    inputSchema: z.object({
      index: z.number().int().nonnegative(),
      lookback: z.string().optional(),
    }),
    async run(ctx, input) {
      const result = await readNews(createNewsArchiveReader(ctx, input.lookback), input)
      return result ?? { error: `News index ${input.index} not found` }
    },
  }),
  defineScript({
    id: 'trader-account-state',
    description: 'Load fresh account, position, order, and market clock state for a configured source.',
    inputSchema: z.object({
      source: z.string().min(1),
    }),
    async run(ctx, input) {
      return buildTraderAccountSnapshot(ctx, input.source)
    },
  }),
  defineScript({
    id: 'trader-review-summaries',
    description: 'Summarize recent trading history and stats for one or more account sources.',
    inputSchema: z.object({
      sources: z.array(z.string().min(1)).min(1),
      limit: z.number().int().positive().default(50),
    }),
    async run(ctx, input) {
      return input.sources.map((source) => {
        const resolvedSource = resolveTraderSource(ctx, source)
        const git = ctx.getAccountGit(resolvedSource)
        if (!git) {
          return { source, summary: 'No trading history available.' }
        }
        const commits = git.log({ limit: input.limit })
        return {
          source: presentTraderSource(ctx, resolvedSource),
          totalCommits: commits.length,
          latestCommit: commits[0]?.hash ?? null,
          latestMessage: commits[0]?.message ?? null,
        }
      })
    },
  }),
  defineScript({
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
      const resolvedSource = resolveTraderSource(ctx, input.source)
      const git = ctx.getAccountGit(resolvedSource)
      if (!git) {
        throw new Error(`No git instance for account "${input.source}"`)
      }

      const staged = []
      for (const order of input.orders) {
        staged.push(git.add({
          action: 'placeOrder',
          params: { ...order },
        }))
      }

      const commit = git.commit(input.commitMessage)
      const pushed = await git.push({ mode: 'best-effort' })
      const commitDetails = git.show(commit.hash)

      return { staged, commit, pushed, commitDetails }
    },
  }),
]

const scriptMap = new Map<string, AnySkillScriptModule>(scripts.map((script) => [script.id, script]))

export function getSkillScript(id: string): AnySkillScriptModule | null {
  return scriptMap.get(id) ?? null
}

export function listSkillScripts(ids?: string[]): AnySkillScriptModule[] {
  if (!ids?.length) return [...scriptMap.values()]
  return ids
    .map((id) => scriptMap.get(id))
    .filter((script): script is AnySkillScriptModule => Boolean(script))
}
