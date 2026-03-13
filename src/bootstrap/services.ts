/**
 * Bootstrap: Services
 *
 * Brain, EventLog, CronEngine, NewsCollectorStore, OpenBB clients, SymbolIndex.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { Config } from '../core/config.js'
import { Brain } from '../extension/cognition/brain/index.js'
import type { BrainExportState } from '../extension/cognition/brain/index.js'
import { createEventLog } from '../core/event-log.js'
import { createCronEngine } from '../task/cron/index.js'
import { NewsCollectorStore } from '../extension/research/news-collector/index.js'
import { OpenBBEquityClient, SymbolIndex } from '../openbb/equity/index.js'
import { OpenBBCryptoClient } from '../openbb/crypto/index.js'
import { OpenBBCurrencyClient } from '../openbb/currency/index.js'
import { OpenBBEconomyClient } from '../openbb/economy/index.js'
import { OpenBBCommodityClient } from '../openbb/commodity/index.js'
import { OpenBBNewsClient } from '../openbb/news/index.js'
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
} from '../openbb/sdk/index.js'
import { buildSDKCredentials } from '../openbb/credential-map.js'
import type { BacktestBar } from '../extension/trading/index.js'

const BRAIN_FILE = resolve('data/brain/commit.json')
const FRONTAL_LOBE_FILE = resolve('data/brain/frontal-lobe.md')
const EMOTION_LOG_FILE = resolve('data/brain/emotion-log.md')
const PERSONA_FILE = resolve('data/brain/persona.md')
const PERSONA_DEFAULT = resolve('data/default/persona.default.md')

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
    readFile(BRAIN_FILE, 'utf-8').then((r) => JSON.parse(r) as BrainExportState).catch(() => undefined),
    readWithDefault(PERSONA_FILE, PERSONA_DEFAULT),
  ])

  const brainDir = resolve('data/brain')
  const brainOnCommit = async (state: BrainExportState) => {
    await mkdir(brainDir, { recursive: true })
    await writeFile(BRAIN_FILE, JSON.stringify(state, null, 2))
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

  // ---- OpenBB / OpenTypeBB Clients ----
  const providerKeys = config.openbb.providerKeys
  const { providers } = config.openbb
  const dataBackend = config.openbb.dataBackend ?? 'sdk'

  let equityClient: EquityClientLike
  let cryptoClient: CryptoClientLike
  let currencyClient: CurrencyClientLike
  let commodityClient: CommodityClientLike
  let economyClient: EconomyClientLike
  let newsClient: NewsClientLike

  if (dataBackend === 'openbb') {
    equityClient = new OpenBBEquityClient(config.openbb.apiUrl, providers.equity, providerKeys)
    cryptoClient = new OpenBBCryptoClient(config.openbb.apiUrl, providers.crypto, providerKeys)
    currencyClient = new OpenBBCurrencyClient(config.openbb.apiUrl, providers.currency, providerKeys)
    commodityClient = new OpenBBCommodityClient(config.openbb.apiUrl, undefined, providerKeys)
    economyClient = new OpenBBEconomyClient(config.openbb.apiUrl, undefined, providerKeys)
    newsClient = new OpenBBNewsClient(config.openbb.apiUrl, undefined, providerKeys)
  } else {
    const executor = getSDKExecutor()
    const routeMap = buildRouteMap()
    const credentials = buildSDKCredentials(providerKeys)

    equityClient = new SDKEquityClient(executor, 'equity', providers.equity, credentials, routeMap)
    cryptoClient = new SDKCryptoClient(executor, 'crypto', providers.crypto, credentials, routeMap)
    currencyClient = new SDKCurrencyClient(executor, 'currency', providers.currency, credentials, routeMap)
    commodityClient = new SDKCommodityClient(executor, 'commodity', undefined, credentials, routeMap)
    economyClient = new SDKEconomyClient(executor, 'economy', undefined, credentials, routeMap)
    newsClient = new SDKNewsClient(executor, 'news', undefined, credentials, routeMap)
  }

  const marketData = {
    async getBacktestBars(query: { assetType: 'equity' | 'crypto'; symbol: string; startDate: string; endDate: string; interval?: string }) {
      if (!config.openbb.enabled) throw new Error('OpenBB is disabled')
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

  return {
    brain, instructions, eventLog, cronEngine, newsStore,
    equityClient, cryptoClient, currencyClient, commodityClient, economyClient, newsClient,
    symbolIndex, marketData, providers,
  }
}
