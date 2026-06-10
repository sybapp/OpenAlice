/**
 * Market Data Service Configuration Constants
 *
 * Centralized configuration values for the market-data service layer.
 * Extract magic numbers to make them visible and configurable.
 */

/**
 * TradingView realtime WebSocket configuration
 */
export const TRADINGVIEW_CONFIG = {
  /** Default timeout for realtime operations (quote/candles/study) in milliseconds */
  REALTIME_TIMEOUT_MS: 10_000,

  /** Default candle range when not specified */
  DEFAULT_CANDLE_RANGE: 300,

  /** Default scanner limit */
  DEFAULT_SCAN_LIMIT: 50,

  /** Maximum scanner limit to prevent excessive API load */
  MAX_SCAN_LIMIT: 1000,

  /** Compact default columns for preset scans (reduced surface) */
  SCAN_COMPACT_COLUMNS: [
    'name',
    'close',
    'change',
    'volume',
    'market_cap_basic',
    'currency',
    'type',
    'sector',
    'AnalystRating',
  ] as const,
} as const

/**
 * Generic market-data service limits
 */
export const MARKET_DATA_CONFIG = {
  /** Default row limit for queries when not specified */
  DEFAULT_LIMIT: 50,

  /** Maximum row limit to prevent memory overflow */
  MAX_LIMIT: 500,
} as const
