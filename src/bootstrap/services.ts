/**
 * Bootstrap: Services
 *
 * Brain, EventLog, CronEngine, NewsCollectorStore, OpenTypeBB clients, SymbolIndex.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Config } from '../core/config.js'
import {
  BRAIN_STATE_FILE,
  EMOTION_LOG_FILE,
  FRONTAL_LOBE_FILE,
  PERSONA_DEFAULT_FILE,
  PERSONA_FILE,
  RUNTIME_BRAIN_DIR,
} from '../core/paths.js'
import { Brain } from '../domains/cognition/brain/index.js'
import type { BrainExportState } from '../domains/cognition/brain/index.js'
import { createEventLog } from '../core/event-log.js'
import { createCronEngine } from '../jobs/cron/index.js'
import { NewsCollectorStore } from '../domains/research/news-collector/index.js'
import { SymbolIndex } from '../integrations/opentypebb/equity/index.js'
import {
  buildRouteMap,
  SDKCommodityClient,
  SDKCryptoClient,
  SDKCurrencyClient,
  SDKEconomyClient,
  SDKEquityClient,
  getSDKExecutor,
  SDKNewsClient,
  type CommodityClientLike,
  type CryptoClientLike,
  type CurrencyClientLike,
  type EconomyClientLike,
  type EquityClientLike,
  type NewsClientLike,
} from '../integrations/opentypebb/sdk/index.js'
import { buildSDKCredentials } from '../integrations/opentypebb/credential-map.js'
import type { BacktestBar } from '../domains/trading/index.js'
import { createOhlcvStore } from '../domains/technical-analysis/indicator-kit/index.js'

async function readWithDefault(target: string, defaultFile: string): Promise<string> {
  try { return await readFile(target, 'utf-8') } catch { /* not found */ }
  try {
    const content = await readFile(defaultFile, 'utf-8')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    return content
  } catch { return '' }
}

interface HistoricalBarRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

function toBacktestIsoTimestamp(input: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00.000Z` : input
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid historical bar timestamp: ${input}`)
  }
  return date.toISOString()
}

function normalizeHistoricalBars(symbol: string, rows: HistoricalBarRow[]): BacktestBar[] {
  return rows
    .map((row) => ({
      ts: toBacktestIsoTimestamp(row.date),
      symbol,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume == null ? 0 : Number(row.volume),
    }))
    .filter((row) => (
      Number.isFinite(row.open)
      && Number.isFinite(row.high)
      && Number.isFinite(row.low)
      && Number.isFinite(row.close)
      && Number.isFinite(row.volume)
    ))
    .sort((a, b) => a.ts.localeCompare(b.ts))
}

export async function initServices(config: Config) {
  // ---- Brain ----
  const [brainExport, persona] = await Promise.all([
    readFile(BRAIN_STATE_FILE, 'utf-8').then((r) => JSON.parse(r) as BrainExportState).catch(() => undefined),
    readWithDefault(PERSONA_FILE, PERSONA_DEFAULT_FILE),
  ])

  const brainOnCommit = async (state: BrainExportState) => {
    await mkdir(RUNTIME_BRAIN_DIR, { recursive: true })
    await writeFile(BRAIN_STATE_FILE, JSON.stringify(state, null, 2))
    await writeFile(FRONTAL_LOBE_FILE, state.state.frontalLobe)
    const latest = state.commits[state.commits.length - 1]
    if (latest?.type === 'emotion') {
      const prev = state.commits.length > 1
        ? state.commits[state.commits.length - 2]?.stateAfter.emotion ?? 'unknown'
        : 'unknown'
      await appendFile(EMOTION_LOG_FILE,
        `## ${latest.timestamp}\n**${prev} → ${latest.stateAfter.emotion}**\n${latest.message}\n\n`)
    }
  }

  const brain = brainExport
    ? Brain.restore(brainExport, { onCommit: brainOnCommit })
    : new Brain({ onCommit: brainOnCommit })

  const frontalLobe = brain.getFrontalLobe()
  const emotion = brain.getEmotion().current
  const instructions = [
    persona, '---', '## Current Brain State', '',
    `**Frontal Lobe:** ${frontalLobe || '(empty)'}`, '',
    `**Emotion:** ${emotion}`,
  ].join('\n')

  // ---- Event Log ----
  const eventLog = await createEventLog()

  // ---- Cron ----
  const cronEngine = createCronEngine({ eventLog })

  // ---- News Collector Store ----
  const newsStore = new NewsCollectorStore({
    maxInMemory: config.newsCollector.maxInMemory,
    retentionDays: config.newsCollector.retentionDays,
  })
  await newsStore.init()

  // ---- OpenTypeBB Clients ----
  const { providers, providerKeys } = config.opentypebb
  const executor = getSDKExecutor()
  const routeMap = buildRouteMap()
  const credentials = buildSDKCredentials(providerKeys)

  const equityClient: EquityClientLike = new SDKEquityClient(executor, 'equity', providers.equity, credentials, routeMap)
  const cryptoClient: CryptoClientLike = new SDKCryptoClient(executor, 'crypto', providers.crypto, credentials, routeMap)
  const currencyClient: CurrencyClientLike = new SDKCurrencyClient(executor, 'currency', providers.currency, credentials, routeMap)
  const commodityClient: CommodityClientLike = new SDKCommodityClient(executor, 'commodity', undefined, credentials, routeMap)
  const economyClient: EconomyClientLike = new SDKEconomyClient(executor, 'economy', undefined, credentials, routeMap)
  const newsClient: NewsClientLike = new SDKNewsClient(executor, 'news', undefined, credentials, routeMap)

  const marketData = {
    async getBacktestBars(query: { assetType: 'equity' | 'crypto'; symbol: string; startDate: string; endDate: string; interval?: string }) {
      if (!config.opentypebb.enabled) throw new Error('OpenTypeBB is disabled')
      const symbol = query.symbol.trim().toUpperCase()
      if (query.assetType === 'equity') {
        const rows = (await equityClient.getHistorical({ symbol, start_date: query.startDate, end_date: query.endDate })) as unknown as HistoricalBarRow[]
        return normalizeHistoricalBars(symbol, rows)
      }
      const rows = (await cryptoClient.getHistorical({
        symbol, start_date: query.startDate, end_date: query.endDate,
        ...(query.interval ? { interval: query.interval } : {}),
      })) as unknown as HistoricalBarRow[]
      return normalizeHistoricalBars(symbol, rows)
    },
  }

  // ---- Symbol Index ----
  const symbolIndex = new SymbolIndex()
  await symbolIndex.load(equityClient)

  const ohlcvStore = createOhlcvStore({ equityClient, cryptoClient, currencyClient })

  return {
    brain, instructions, eventLog, cronEngine, newsStore,
    equityClient, cryptoClient, currencyClient, commodityClient, economyClient, newsClient,
    symbolIndex, marketData, providers,
    ohlcvStore,
  }
}
