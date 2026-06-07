import { tool } from 'ai'
import { z } from 'zod'
import type {
  MarketDataAssetClass,
  MarketDataScanPreset,
  MarketDataService,
} from '@/services/market-data/index.js'

type MarketDataToolService = Pick<MarketDataService, 'catalog' | 'query' | 'scan' | 'search'>
  & Pick<MarketDataService, 'indicator'>

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

Asset classes: "equity", "crypto", "currency", or "commodity". Formula syntax matches
calculateIndicator: CLOSE/HIGH/LOW/OPEN/VOLUME data access; SMA/EMA/STDEV/MAX/MIN/SUM/AVERAGE;
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
  }
}
