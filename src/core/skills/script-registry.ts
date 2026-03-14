import { z } from 'zod'
import type { Config } from '../config.js'
import type { EventLog } from '../event-log.js'
import type { Brain } from '../../extension/cognition/brain/index.js'
import type { AccountManager } from '../../extension/trading/index.js'
import type { ITradingGit } from '../../extension/trading/index.js'
import type { MarketDataBridge } from '../types.js'
import type { SymbolIndex } from '../../openbb/equity/index.js'
import type { EquityClientLike, CryptoClientLike, CurrencyClientLike, NewsClientLike } from '../../openbb/sdk/types.js'
import type { INewsProvider } from '../../extension/research/news-collector/types.js'
import { analyzeBrooksPa } from '../../extension/technical-analysis/brooks-pa/analyzer/index.js'
import { buildBrooksCoreFromDetailed } from '../../extension/technical-analysis/brooks-pa/analyzer/core.js'
import type { Timeframes } from '../../extension/technical-analysis/brooks-pa/types.js'
import { analyzeIctSmc } from '../../extension/technical-analysis/ict-smc/analyze.js'
import { IndicatorCalculator, getCalendarDaysForInterval } from '../../extension/technical-analysis/indicator-kit/index.js'
import type { OhlcvData } from '../../extension/technical-analysis/indicator-kit/index.js'
import type { OhlcvStore } from '../../extension/technical-analysis/indicator-kit/index.js'
import { computeDedupKey } from '../../extension/research/news-collector/index.js'
import { globNews, grepNews, readNews } from '../../extension/research/news-collector/tools.js'

export interface SkillScriptContext {
  config: Config
  eventLog: EventLog
  brain: Brain
  accountManager: AccountManager
  marketData: MarketDataBridge
  symbolIndex: SymbolIndex
  ohlcvStore: OhlcvStore
  equityClient: EquityClientLike
  cryptoClient: CryptoClientLike
  currencyClient: CurrencyClientLike
  newsClient: NewsClientLike
  newsStore: INewsProvider
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

async function searchMarket(ctx: SkillScriptContext, query: string, limit: number = 20) {
  const equityResults = ctx.symbolIndex.search(query, limit).map((result) => ({
    ...result,
    assetClass: 'equity' as const,
  }))

  const [cryptoSettled, currencySettled] = await Promise.allSettled([
    ctx.cryptoClient.search({ query, provider: 'yfinance' }),
    ctx.currencyClient.search({ query, provider: 'yfinance' }),
  ])

  const cryptoResults = (cryptoSettled.status === 'fulfilled' ? cryptoSettled.value : []).map((result) => ({
    ...result,
    assetClass: 'crypto' as const,
  }))

  const currencyResults = (currencySettled.status === 'fulfilled' ? currencySettled.value : [])
    .filter((result) => {
      const symbol = (result as Record<string, unknown>).symbol as string | undefined
      return symbol?.endsWith('USD')
    })
    .map((result) => ({ ...result, assetClass: 'currency' as const }))

  const results = [...equityResults, ...cryptoResults, ...currencyResults]
  if (results.length === 0) {
    return { results: [], message: `No symbols matching "${query}". Try a different keyword.` }
  }
  return { results, count: results.length }
}

async function piggybackNewsResults(
  ctx: SkillScriptContext,
  result: unknown,
  ingestSource: 'openbb-company' | 'openbb-world',
  symbol?: string,
) {
  if (!ctx.config.newsCollector.piggybackOpenBB) return
  if (!('ingest' in ctx.newsStore) || typeof (ctx.newsStore as { ingest?: unknown }).ingest !== 'function') return

  const items = Array.isArray(result) ? result : []
  const store = ctx.newsStore as INewsProvider & {
    ingest: (item: {
      title: string
      content: string
      pubTime: Date
      dedupKey: string
      metadata: Record<string, string | null>
    }) => Promise<boolean>
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const title = String(raw.title ?? '')
    if (!title) continue
    const content = String(raw.text ?? raw.summary ?? raw.content ?? raw.description ?? '')
    const link = raw.url ? String(raw.url) : null
    const dateValue = raw.date ?? raw.published_utc ?? raw.datetime ?? raw.pubDate
    const pubTime = dateValue ? new Date(String(dateValue)) : new Date()
    const dedupKey = computeDedupKey({
      guid: raw.id ? String(raw.id) : undefined,
      link: link ?? undefined,
      title,
      content,
    })

    await store.ingest({
      title,
      content,
      pubTime: Number.isNaN(pubTime.getTime()) ? new Date() : pubTime,
      dedupKey,
      metadata: {
        source: ingestSource,
        link,
        ingestSource,
        ...(symbol ? { symbol } : {}),
      },
    })
  }
}

function createNewsArchiveReader(ctx: SkillScriptContext, lookback?: string) {
  return {
    getNews: () => ctx.newsStore.getNewsV2({ endTime: new Date(), lookback, limit: 500 }),
  }
}

const scripts = [
  {
    id: 'research-market-search',
    description: 'Search symbols across equity, crypto, and currency before running analysis.',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      return searchMarket(ctx, input.query, input.limit)
    },
  },
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
  },
  {
    id: 'research-news-company',
    description: 'Load recent company-specific news.',
    inputSchema: z.object({
      symbol: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      const params: Record<string, unknown> = {
        symbol: input.symbol,
        provider: ctx.config.openbb.providers.newsCompany,
      }
      if (input.limit) params.limit = input.limit
      const result = await ctx.newsClient.getCompanyNews(params)
      await piggybackNewsResults(ctx, result, 'openbb-company', input.symbol)
      return result
    },
  },
  {
    id: 'research-news-world',
    description: 'Load recent world or macro news.',
    inputSchema: z.object({
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      const params: Record<string, unknown> = {
        provider: ctx.config.openbb.providers.newsWorld,
      }
      if (input.limit) params.limit = input.limit
      const result = await ctx.newsClient.getWorldNews(params)
      await piggybackNewsResults(ctx, result, 'openbb-world')
      return result
    },
  },
  {
    id: 'research-equity-profile',
    description: 'Load company profile and key metrics.',
    inputSchema: z.object({
      symbol: z.string().min(1),
    }),
    async run(ctx, input) {
      const [profile, metrics] = await Promise.all([
        ctx.equityClient.getProfile({ symbol: input.symbol, provider: 'yfinance' }).catch(() => []),
        ctx.equityClient.getKeyMetrics({ symbol: input.symbol, limit: 1, provider: 'yfinance' }).catch(() => []),
      ])
      return { profile: profile[0] ?? null, metrics: metrics[0] ?? null }
    },
  },
  {
    id: 'research-equity-financials',
    description: 'Load company financial statements.',
    inputSchema: z.object({
      symbol: z.string().min(1),
      type: z.enum(['income', 'balance', 'cash']),
      period: z.enum(['annual', 'quarter']).optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      const params: Record<string, unknown> = { symbol: input.symbol, provider: 'yfinance' }
      if (input.period) params.period = input.period
      if (input.limit) params.limit = input.limit

      switch (input.type) {
        case 'income':
          return ctx.equityClient.getIncomeStatement(params)
        case 'balance':
          return ctx.equityClient.getBalanceSheet(params)
        case 'cash':
          return ctx.equityClient.getCashFlow(params)
      }
    },
  },
  {
    id: 'research-equity-ratios',
    description: 'Load company financial ratios.',
    inputSchema: z.object({
      symbol: z.string().min(1),
      period: z.enum(['annual', 'quarter']).optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(ctx, input) {
      const params: Record<string, unknown> = { symbol: input.symbol, provider: 'fmp' }
      if (input.period) params.period = input.period
      if (input.limit) params.limit = input.limit
      return ctx.equityClient.getFinancialRatios(params)
    },
  },
  {
    id: 'research-equity-estimates',
    description: 'Load analyst estimate consensus for a company.',
    inputSchema: z.object({
      symbol: z.string().min(1),
    }),
    async run(ctx, input) {
      return ctx.equityClient.getEstimateConsensus({ symbol: input.symbol, provider: 'yfinance' })
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
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
      const git = ctx.getAccountGit(input.source)
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
