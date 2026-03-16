/**
 * Bootstrap: Services
 *
 * Brain, EventLog, CronEngine, NewsCollectorStore, and CCXT-backed market data.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Config } from '../core/config.js'
import ccxt from 'ccxt'
import type { Exchange } from 'ccxt'
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

function normalizeCcxtSymbol(input: string): string {
  const symbol = input.trim().toUpperCase()
  if (symbol.includes('/')) return symbol
  for (const quote of ['USDT', 'USDC', 'USD', 'BTC', 'ETH']) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return `${symbol.slice(0, -quote.length)}/${quote}`
    }
  }
  return symbol
}

function toEndOfDayIso(date: string): string {
  return `${date}T23:59:59.999Z`
}

function createCcxtExchange(config: Config): Exchange {
  if (config.crypto.provider.type !== 'ccxt') {
    throw new Error('Crypto CCXT provider is disabled')
  }
  const p = config.crypto.provider
  const exchanges = ccxt as unknown as Record<string, new (opts: Record<string, unknown>) => Exchange>
  const ExchangeClass = exchanges[p.exchange]
  if (!ExchangeClass) {
    throw new Error(`Unknown CCXT exchange: ${p.exchange}`)
  }
  const exchange = new ExchangeClass({
    apiKey: p.apiKey,
    secret: p.apiSecret,
    password: p.password,
    options: p.options,
    enableRateLimit: true,
  })
  if (p.sandbox) exchange.setSandboxMode(true)
  if (p.demoTrading) {
    (exchange as unknown as { enableDemoTrading?: (enable: boolean) => void }).enableDemoTrading?.(true)
  }
  return exchange
}

async function fetchCcxtHistoricalBars(params: {
  exchange: Exchange
  symbol: string
  startDate: string
  endDate: string
  interval: string
}): Promise<HistoricalBarRow[]> {
  const { exchange, symbol, startDate, endDate, interval } = params
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`)
  const endMs = Date.parse(toEndOfDayIso(endDate))
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error('Invalid date range for historical bars')
  }

  await exchange.loadMarkets()
  const candidate = normalizeCcxtSymbol(symbol)
  const market = (() => {
    try {
      return exchange.market(candidate)
    } catch {
      return null
    }
  })()
  const resolvedSymbol = market?.symbol ?? candidate
  const timeframe = interval.trim() || '1d'
  const timeframeSeconds = exchange.parseTimeframe(timeframe)
  if (!Number.isFinite(timeframeSeconds) || timeframeSeconds <= 0) {
    throw new Error(`Unsupported interval: ${timeframe}`)
  }
  const timeframeMs = timeframeSeconds * 1000

  const rows: HistoricalBarRow[] = []
  let since = startMs
  const limit = 1000
  while (since <= endMs) {
    const batch = await exchange.fetchOHLCV(resolvedSymbol, timeframe, since, limit)
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const item of batch) {
      const [ts, open, high, low, close, volume] = item
      if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue
      rows.push({
        date: new Date(ts).toISOString(),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: volume == null ? null : Number(volume),
      })
    }

    const lastTs = Number(batch[batch.length - 1]?.[0] ?? NaN)
    if (!Number.isFinite(lastTs)) break
    const nextSince = lastTs + timeframeMs
    if (nextSince <= since) break
    since = nextSince
    if (batch.length < limit) break
  }
  return rows
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

  const ccxtExchange = config.crypto.provider.type === 'ccxt'
    ? createCcxtExchange(config)
    : null

  const marketData = {
    async getBacktestBars(query: { assetType: 'crypto'; symbol: string; startDate: string; endDate: string; interval?: string }) {
      if (query.assetType !== 'crypto') {
        throw new Error('Only crypto bars are supported')
      }
      if (!ccxtExchange) {
        throw new Error('Crypto CCXT provider is disabled')
      }
      const rows = await fetchCcxtHistoricalBars({
        exchange: ccxtExchange,
        symbol: query.symbol,
        startDate: query.startDate,
        endDate: query.endDate,
        interval: query.interval ?? '1d',
      })
      return normalizeHistoricalBars(normalizeCcxtSymbol(query.symbol), rows)
    },
  }

  const ohlcvStore = createOhlcvStore({
    cryptoClient: {
      getHistorical: async (params: Record<string, unknown>) => {
        const symbol = String(params.symbol ?? '').trim()
        const startDate = String(params.start_date ?? '').trim()
        const interval = String(params.interval ?? '1h')
        if (!ccxtExchange) {
          throw new Error('Crypto CCXT provider is disabled')
        }
        const today = new Date().toISOString().slice(0, 10)
        const rows = await fetchCcxtHistoricalBars({
          exchange: ccxtExchange,
          symbol,
          startDate,
          endDate: today,
          interval,
        })
        return rows
      },
    },
  })

  return {
    brain, instructions, eventLog, cronEngine, newsStore,
    marketData,
    ohlcvStore,
  }
}
