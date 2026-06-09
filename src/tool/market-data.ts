import { tool } from 'ai'
import { z } from 'zod'
import type {
  MarketDataAssetClass,
  MarketDataScanPreset,
  MarketDataService,
} from '@/services/market-data/index.js'

type MarketDataToolService = Pick<MarketDataService, 'catalog' | 'query' | 'scan' | 'search'>
  & Pick<MarketDataService, 'indicator'>
  & Pick<MarketDataService,
    | 'searchTradingViewSymbols'
    | 'technicalAnalysis'
    | 'searchTradingViewIndicators'
    | 'getTradingViewIndicator'
    | 'tradingViewCandles'
    | 'runTradingViewStudy'
  >

const jsonRecordInput = z.union([
  z.record(z.string(), z.unknown()),
  z.string(),
])

const credentialsInput = z.union([
  z.record(z.string(), z.string()),
  z.string(),
])

const searchAssetClassSchema = z.enum(['equity', 'crypto', 'currency', 'commodity', 'etf', 'index'])

const scanPresetSchema = z.enum([
  'stocks',
  'coin',
  'crypto',
  'cryptoDex',
  'crypto_dex',
  'forex',
  'futures',
  'bond',
  'cfd',
  'options',
])

function parseJsonRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch (error) {
      throw new Error(`${field} must be a JSON object string: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw new Error(`${field} must be a JSON object string.`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`${field} must be an object.`)
}

function parseCredentials(value: unknown): Record<string, string> | undefined {
  const parsed = parseJsonRecord(value, 'credentials')
  if (!parsed) {
    return undefined
  }
  const credentials: Record<string, string> = {}
  for (const [key, credential] of Object.entries(parsed)) {
    if (typeof credential !== 'string') {
      throw new Error(`credentials.${key} must be a string.`)
    }
    credentials[key] = credential
  }
  return credentials
}

function parsePrimitiveRecord(value: unknown, field: string): Record<string, string | number | boolean> | undefined {
  const parsed = parseJsonRecord(value, field)
  if (!parsed) {
    return undefined
  }
  const result: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${field}.${key} must be a string, number, or boolean.`)
    }
    result[key] = item
  }
  return result
}

function parseTradingViewIndicatorRef(value: unknown): { id: string; version?: string } | undefined {
  const parsed = parseJsonRecord(value, 'indicator')
  if (!parsed) {
    return undefined
  }
  if (typeof parsed['id'] !== 'string') {
    throw new Error('indicator.id must be a string.')
  }
  if (parsed['version'] !== undefined && typeof parsed['version'] !== 'string') {
    throw new Error('indicator.version must be a string.')
  }
  return {
    id: parsed['id'],
    version: parsed['version'],
  }
}

export function createMarketDataTools(service: MarketDataToolService) {
  return {
    marketDataCatalog: tool({
      description: `List available generic market-data providers and endpoints.

Use this before marketDataQuery when you need to discover endpoint paths,
provider coverage, output model names, or credential requirements.`,
      inputSchema: z.object({}).meta({ examples: [{}] }),
      execute: async () => service.catalog(),
    }),

    marketDataQuery: tool({
      description: `Run a generic market-data endpoint by path.

The endpoint may be passed with or without a leading slash, for example
"/equity/price/historical" or "equity/price/historical". Pass params as an
object, or as a JSON object string when using the alice CLI.`,
      inputSchema: z.object({
        endpoint: z.string().describe('Generic endpoint path, e.g. "/equity/price/historical"'),
        provider: z.string().optional().describe('Provider override. Defaults to configured provider for the endpoint asset class.'),
        params: jsonRecordInput.optional().describe('Endpoint params object, or JSON object string for CLI flags.'),
        limit: z.number().int().nonnegative().optional().describe('Max rows to return. Clamped by the service.'),
        credentials: credentialsInput.optional().describe('Provider credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ endpoint: '/equity/price/historical', params: { symbol: 'AAPL' }, limit: 5 }] }),
      execute: async ({ endpoint, provider, params, limit, credentials }) => service.query({
        endpoint,
        provider,
        params: parseJsonRecord(params, 'params'),
        limit,
        credentials: parseCredentials(credentials),
      }),
    }),

    marketDataScan: tool({
      description: `Run a TradingView market scanner preset or custom scanner query.

By default this scans the stocks preset. For custom scans, set mode to "query"
or "raw" and pass query as an object, or as a JSON object string when using
the alice CLI.`,
      inputSchema: z.object({
        provider: z.string().optional().describe('Scanner provider. Currently only "tradingview" is supported.'),
        mode: z.enum(['preset', 'query', 'raw']).optional().describe('Scan mode. Defaults to preset.'),
        preset: scanPresetSchema.optional().describe('TradingView scanner preset. Defaults to stocks.'),
        market: z.string().optional().describe('Optional market/exchange/underlying, depending on preset.'),
        query: jsonRecordInput.optional().describe('Custom TradingView query object, or JSON object string for CLI flags.'),
        limit: z.number().int().nonnegative().optional().describe('Max rows to return. Clamped by the service.'),
        credentials: z.union([z.record(z.string(), z.string()), z.string(), z.null()]).optional().describe('TradingView credentials object, JSON object string, or null.'),
      }).meta({ examples: [{ preset: 'stocks', market: 'america', limit: 25 }] }),
      execute: async ({ provider, mode, preset, market, query, limit, credentials }) => service.scan({
        provider,
        mode,
        preset: preset as MarketDataScanPreset | undefined,
        market,
        query: parseJsonRecord(query, 'query'),
        limit,
        credentials: credentials === null ? null : parseCredentials(credentials),
      }),
    }),

    marketDataSearch: tool({
      description: `Search symbols for a supported asset class through the generic market-data service.

Returns the normalized service envelope directly. Pass params as an object, or
as a JSON object string when using the alice CLI.`,
      inputSchema: z.object({
        assetClass: searchAssetClassSchema.describe('Asset class to search.'),
        query: z.string().describe('Search keyword, ticker, or symbol fragment.'),
        provider: z.string().optional().describe('Provider override. Defaults to configured provider for the asset class.'),
        limit: z.number().int().nonnegative().optional().describe('Max rows to return. Clamped by the service.'),
        params: jsonRecordInput.optional().describe('Extra provider params object, or JSON object string for CLI flags.'),
        credentials: credentialsInput.optional().describe('Provider credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ assetClass: 'equity', query: 'apple', limit: 10 }] }),
      execute: async ({ assetClass, query, provider, limit, params, credentials }) => service.search({
        assetClass: assetClass as Exclude<MarketDataAssetClass, 'derivatives' | 'economy' | 'news'>,
        query,
        provider,
        limit,
        params: parseJsonRecord(params, 'params'),
        credentials: parseCredentials(credentials),
      }),
    }),

    marketDataIndicator: tool({
      description: `Calculate technical indicators through the generic market-data service.

Asset classes: "equity", "crypto", "currency", or "commodity". Formula syntax supports
CLOSE/HIGH/LOW/OPEN/VOLUME data access; SMA/EMA/STDEV/MAX/MIN/SUM/AVERAGE;
RSI/BBANDS/MACD/ATR; and arithmetic with +, -, *, /.

Returns { value, dataRange } where dataRange shows the actual date span and bar count used.`,
      inputSchema: z.object({
        asset: z.enum(['equity', 'crypto', 'currency', 'commodity']).describe('Asset class.'),
        formula: z.string().describe("Formula expression, e.g. SMA(CLOSE('AAPL', '1d'), 50)."),
        precision: z.number().int().min(0).max(10).optional().describe('Decimal places. Defaults to 4.'),
        provider: z.string().optional().describe('Provider override. Defaults to configured provider for the asset class.'),
        credentials: credentialsInput.optional().describe('Provider credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ asset: 'equity', formula: "SMA(CLOSE('AAPL', '1d'), 50)" }] }),
      execute: async ({ asset, formula, precision, provider, credentials }) => service.indicator({
        asset,
        formula,
        precision,
        provider,
        credentials: parseCredentials(credentials),
      }),
    }),

    tradingViewSymbolSearch: tool({
      description: `Search TradingView symbols through TradingView's symbol search.

Use this when an agent needs the exact TradingView symbol string before scanner,
technical-analysis, realtime candles, or indicator execution calls.`,
      inputSchema: z.object({
        query: z.string().describe('Symbol query, ticker, or exchange-qualified symbol fragment.'),
        type: z.string().optional().describe('Optional TradingView market type filter, e.g. stock, futures, crypto, forex.'),
        offset: z.number().int().nonnegative().optional().describe('Result offset.'),
        limit: z.number().int().nonnegative().optional().describe('Max rows to return. Clamped by the service.'),
        credentials: credentialsInput.optional().describe('TradingView credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ query: 'nasdaq:aapl', type: 'stock', limit: 5 }] }),
      execute: async ({ query, type, offset, limit, credentials }) => service.searchTradingViewSymbols({
        query,
        type,
        offset,
        limit,
        credentials: parseCredentials(credentials),
      }),
    }),

    tradingViewTechnicalAnalysis: tool({
      description: `Fetch TradingView technical-analysis recommendation values.

Returns TradingView recommendation fields by requested periods for a symbol such
as "NASDAQ:AAPL" or "BINANCE:BTCUSDT".`,
      inputSchema: z.object({
        symbol: z.string().describe('TradingView symbol, e.g. NASDAQ:AAPL.'),
        periods: z.array(z.string()).optional().describe('TradingView TA periods, e.g. ["1D", "1W", "1M"]. Defaults to service/provider defaults.'),
        credentials: credentialsInput.optional().describe('TradingView credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ symbol: 'NASDAQ:AAPL', periods: ['1D', '1W'] }] }),
      execute: async ({ symbol, periods, credentials }) => service.technicalAnalysis({
        symbol,
        periods,
        credentials: parseCredentials(credentials),
      }),
    }),

    tradingViewIndicatorSearch: tool({
      description: `Search public and built-in TradingView Pine indicators.

Use this before tradingViewIndicatorGet when an agent needs a Pine script id or
wants to discover built-in study names.`,
      inputSchema: z.object({
        query: z.string().optional().describe('Indicator search query. Empty string lists popular/default results.'),
        includeBuiltIn: z.boolean().optional().describe('Include TradingView built-in studies in the result set.'),
        limit: z.number().int().nonnegative().optional().describe('Max rows to return. Clamped by the service.'),
        credentials: credentialsInput.optional().describe('TradingView credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ query: 'RSI', includeBuiltIn: true, limit: 10 }] }),
      execute: async ({ query, includeBuiltIn, limit, credentials }) => service.searchTradingViewIndicators({
        query,
        includeBuiltIn,
        limit,
        credentials: parseCredentials(credentials),
      }),
    }),

    tradingViewIndicatorGet: tool({
      description: `Get TradingView Pine indicator metadata and script payload by id.

Returns inputs, plot names, script type, and script text needed to run a
TradingView chart study.`,
      inputSchema: z.object({
        id: z.string().describe('TradingView indicator id, e.g. PUB;XXXXXXXXXXXXXXXX.'),
        version: z.string().optional().describe('Indicator version. Defaults to last.'),
        credentials: credentialsInput.optional().describe('TradingView credentials object, or JSON object string for CLI flags.'),
      }).meta({ examples: [{ id: 'PUB;XXXXXXXXXXXXXXXX', version: 'last' }] }),
      execute: async ({ id, version, credentials }) => service.getTradingViewIndicator({
        id,
        version,
        credentials: parseCredentials(credentials),
      }),
    }),

    tradingViewCandles: tool({
      description: `Get a one-shot TradingView candle snapshot through the realtime chart adapter.

Use this when an agent needs TradingView-normalized OHLCV data, custom chart
types, replay initialization, or TradingView-specific symbol handling without
holding an open subscription.`,
      inputSchema: z.object({
        symbol: z.string().describe('TradingView symbol, e.g. NASDAQ:AAPL or BINANCE:BTCUSDT.'),
        options: jsonRecordInput.optional().describe('TradingView chart options object or JSON string, e.g. {"timeframe":"60","range":100}.'),
        credentials: credentialsInput.optional().describe('TradingView credentials object, or JSON object string for CLI flags.'),
        timeoutMs: z.number().int().positive().optional().describe('Timeout waiting for the first realtime candle update.'),
      }).meta({ examples: [{ symbol: 'NASDAQ:AAPL', options: { timeframe: '60', range: 100 } }] }),
      execute: async ({ symbol, options, credentials, timeoutMs }) => service.tradingViewCandles({
        symbol,
        options: parseJsonRecord(options, 'options'),
        credentials: parseCredentials(credentials),
        timeoutMs,
      }),
    }),

    tradingViewStudy: tool({
      description: `Run a TradingView chart study once and return parsed indicator values.

Use builtInType for built-in studies like "Volume@tv-basicstudies-241", or
indicatorId for public Pine indicators returned by tradingViewIndicatorSearch.
The result includes points, graphics, strategyReport, and the latest candles
seen before the study update.`,
      inputSchema: z.object({
        symbol: z.string().describe('TradingView symbol, e.g. NASDAQ:AAPL.'),
        options: jsonRecordInput.optional().describe('TradingView chart options object or JSON string, e.g. {"timeframe":"60","range":100}.'),
        indicator: jsonRecordInput.optional().describe('Indicator search result object or JSON string from tradingViewIndicatorSearch.'),
        indicatorId: z.string().optional().describe('Public Pine indicator id, e.g. PUB;XXXXXXXXXXXXXXXX, or a built-in @tv-* study id.'),
        indicatorVersion: z.string().optional().describe('Pine indicator version. Defaults to last.'),
        builtInType: z.string().optional().describe('Built-in TradingView study type, e.g. Volume@tv-basicstudies-241.'),
        inputs: jsonRecordInput.optional().describe('Study input overrides object or JSON string. Values must be string, number, or boolean.'),
        credentials: credentialsInput.optional().describe('TradingView credentials object, or JSON object string for CLI flags.'),
        timeoutMs: z.number().int().positive().optional().describe('Timeout waiting for the first study update.'),
      }).meta({ examples: [{ symbol: 'NASDAQ:AAPL', builtInType: 'Volume@tv-basicstudies-241', options: { timeframe: '60', range: 100 } }] }),
      execute: async ({ symbol, options, indicator, indicatorId, indicatorVersion, builtInType, inputs, credentials, timeoutMs }) => service.runTradingViewStudy({
        symbol,
        options: parseJsonRecord(options, 'options'),
        indicator: parseTradingViewIndicatorRef(indicator),
        indicatorId,
        indicatorVersion,
        builtInType,
        inputs: parsePrimitiveRecord(inputs, 'inputs'),
        credentials: parseCredentials(credentials),
        timeoutMs,
      }),
    }),
  }
}
