import { tool } from 'ai'
import { z } from 'zod'
import { readMarketDataConfig, writeConfigSection } from '@/core/config'
import type { MarketDataAlertRunResult, MarketDataWatchRunResult } from '@/domain/market-data/ohlcv'
import {
  addMarketDataAlert,
  addMarketDataWatch,
  listMarketDataAlertRuns,
  listMarketDataAlerts,
  listMarketDataWatchWithCache,
  normalizeAlertRunsQuery,
  recordMarketDataAlertFeedback,
  removeMarketDataAlert,
  removeMarketDataWatch,
  setMarketDataAlertsEnabled,
  setMarketDataWatchEnabled,
} from '@/domain/market-data/ohlcv'

const ohlcvAssetSchema = z.enum(['equity', 'crypto', 'currency', 'commodity'])
const alertModeSchema = z.enum(['deterministic', 'agent', 'both'])
const alertRunStatusSchema = z.enum(['triggered', 'skipped', 'error'])
const alertFeedbackRatingSchema = z.enum(['useful', 'false_positive', 'ignored', 'needs_tuning'])

type MarketDataConfig = Awaited<ReturnType<typeof readMarketDataConfig>>

export interface MarketDataToolDeps {
  runWatchNow?: () => Promise<MarketDataWatchRunResult>
  runAlertsNow?: () => Promise<MarketDataAlertRunResult>
}

export function createMarketDataTools(deps: MarketDataToolDeps = {}) {
  async function writeMarketDataConfig(config: MarketDataConfig): Promise<MarketDataConfig> {
    return await writeConfigSection('marketData', config) as MarketDataConfig
  }

  return {
    listMarketDataWatch: tool({
      description: `List configured OHLCV market-data watch items.

This is read-only. It shows which symbols/timeframes are prewarmed into the local OHLCV cache and does not fetch provider data.`,
      inputSchema: z.object({}),
      execute: async () => {
        return await listMarketDataWatchWithCache(await readMarketDataConfig())
      },
    }),
    addMarketDataWatch: tool({
      description: `Add or update an OHLCV watch item.

The watcher periodically prewarms local OHLCV cache. Adding an existing asset/symbol/provider merges intervals and updates lookbackBars.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol, e.g. QQQ, AAPL, BTCUSD, EURUSD, gold'),
        intervals: z.array(z.string().min(1)).min(1).describe("Intervals to prewarm, e.g. ['5m', '1h', '1d']"),
        provider: z.string().optional().describe('Optional provider override; defaults to market-data config provider for asset'),
        lookbackBars: z.number().int().positive().max(5000).default(300).describe('Approximate bars to keep warm per interval'),
        enableWatch: z.boolean().default(true).describe('Enable the market-data watcher after adding this item'),
      }),
      execute: async ({ asset, symbol, intervals, provider, lookbackBars, enableWatch }) => {
        const { next, result } = addMarketDataWatch(await readMarketDataConfig(), { asset, symbol, intervals, provider, lookbackBars, enableWatch })
        await writeMarketDataConfig(next)
        return result
      },
    }),
    removeMarketDataWatch: tool({
      description: `Remove an OHLCV watch item, or remove only selected intervals from an item.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol to remove'),
        provider: z.string().optional().describe('Optional provider override matching the watched item'),
        intervals: z.array(z.string().min(1)).optional().describe('Optional intervals to remove; omit to remove the whole item'),
      }),
      execute: async ({ asset, symbol, provider, intervals }) => {
        const { next, result } = removeMarketDataWatch(await readMarketDataConfig(), { asset, symbol, provider, intervals })
        await writeMarketDataConfig(next)
        return result
      },
    }),
    setMarketDataWatchEnabled: tool({
      description: `Enable or disable the OHLCV market-data watcher without changing watched symbols.`,
      inputSchema: z.object({
        enabled: z.boolean(),
        every: z.string().min(1).optional().describe("Optional schedule interval, e.g. '5m', '15m', '1h'"),
      }),
      execute: async ({ enabled, every }) => {
        const { next, result } = setMarketDataWatchEnabled(await readMarketDataConfig(), { enabled, every })
        await writeMarketDataConfig(next)
        return result
      },
    }),
    runMarketDataWatchNow: tool({
      description: `Run the OHLCV market-data watcher immediately and return structured prewarm results.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (!deps.runWatchNow) {
          return {
            error: {
              code: 'MARKET_DATA_WATCHER_UNAVAILABLE',
              message: 'Market data watcher is not available in this runtime.',
            },
          }
        }
        return await deps.runWatchNow()
      },
    }),
    listMarketDataAlerts: tool({
      description: `List configured market-data alerts. This does not fetch provider data.`,
      inputSchema: z.object({}),
      execute: async () => {
        return listMarketDataAlerts(await readMarketDataConfig())
      },
    }),
    addMarketDataAlert: tool({
      description: `Add or update a market-data technical-analysis alert and ensure matching OHLCV watch prewarm exists.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1).describe('Market data symbol, e.g. QQQ, AAPL, BTCUSD, EURUSD, gold'),
        interval: z.string().min(1).default('5m').describe("Candle interval, e.g. '5m', '15m', '1h', '1d'. Commodities use 1d."),
        provider: z.string().optional().describe('Optional provider override; defaults to market-data config provider for asset'),
        enabled: z.boolean().default(true).describe('Whether this alert item is active'),
        mode: alertModeSchema.optional().describe('Optional mode override for this item'),
        lookbackBars: z.number().int().positive().max(5000).default(300).describe('Bars to analyze per run'),
        cooldownMinutes: z.number().int().nonnegative().optional().describe('Minimum minutes before repeating the same signal'),
        maxSignalAgeBars: z.number().int().positive().default(3).describe('Only alert on signals within this many latest bars'),
        minVolumeScore: z.number().optional().describe('Optional minimum volume z-score for volume signals'),
        enableAlerts: z.boolean().default(true).describe('Enable the alert scheduler after adding this item'),
        ensureWatch: z.boolean().default(true).describe('Also upsert matching OHLCV watch item'),
      }),
      execute: async ({
        asset,
        symbol,
        interval,
        provider,
        enabled,
        mode,
        lookbackBars,
        cooldownMinutes,
        maxSignalAgeBars,
        minVolumeScore,
        enableAlerts,
        ensureWatch,
      }) => {
        const { next, result } = addMarketDataAlert(await readMarketDataConfig(), {
          asset,
          symbol,
          interval,
          provider,
          enabled,
          mode,
          lookbackBars,
          cooldownMinutes,
          maxSignalAgeBars,
          minVolumeScore,
          enableAlerts,
          ensureWatch,
        })
        await writeMarketDataConfig(next)
        return result
      },
    }),
    removeMarketDataAlert: tool({
      description: `Remove a configured market-data alert item.`,
      inputSchema: z.object({
        asset: ohlcvAssetSchema.describe('Asset class'),
        symbol: z.string().min(1),
        interval: z.string().min(1),
        provider: z.string().optional(),
      }),
      execute: async ({ asset, symbol, interval, provider }) => {
        const { next, result } = removeMarketDataAlert(await readMarketDataConfig(), { asset, symbol, interval, provider })
        await writeMarketDataConfig(next)
        return result
      },
    }),
    setMarketDataAlertsEnabled: tool({
      description: `Enable or disable market-data alerts without changing alert items.`,
      inputSchema: z.object({
        enabled: z.boolean(),
        every: z.string().min(1).optional().describe("Optional schedule interval, e.g. '5m', '15m', '1h'"),
        mode: alertModeSchema.optional().describe('Optional global alert mode'),
      }),
      execute: async ({ enabled, every, mode }) => {
        const { next, result } = setMarketDataAlertsEnabled(await readMarketDataConfig(), { enabled, every, mode })
        await writeMarketDataConfig(next)
        return result
      },
    }),
    runMarketDataAlertsNow: tool({
      description: `Run market-data alerts immediately and return structured signal results.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (!deps.runAlertsNow) {
          return {
            error: {
              code: 'MARKET_DATA_ALERTS_UNAVAILABLE',
              message: 'Market data alert scheduler is not available in this runtime.',
            },
          }
        }
        return await deps.runAlertsNow()
      },
    }),
    listMarketDataAlertRuns: tool({
      description: `List recent persisted market-data alert run records with optional filters.

Use this before judging alert quality or tuning technical-analysis alert thresholds. This is read-only and does not fetch provider data.`,
      inputSchema: z.object({
        limit: z.number().int().positive().max(500).default(50),
        asset: ohlcvAssetSchema.optional(),
        symbol: z.string().min(1).optional(),
        interval: z.string().min(1).optional(),
        status: alertRunStatusSchema.optional(),
      }),
      execute: async ({ limit, asset, symbol, interval, status }) => {
        return await listMarketDataAlertRuns(normalizeAlertRunsQuery({ limit, asset, symbol, interval, status }))
      },
    }),
    recordMarketDataAlertFeedback: tool({
      description: `Record human or agent feedback for a persisted market-data alert run.

Feedback is used for later review and threshold tuning; it does not place trades or automatically change alert config.`,
      inputSchema: z.object({
        runId: z.string().min(1),
        rating: alertFeedbackRatingSchema,
        note: z.string().max(1000).optional(),
      }),
      execute: async ({ runId, rating, note }) => {
        return await recordMarketDataAlertFeedback({ runId, rating, note })
      },
    }),
  }
}
