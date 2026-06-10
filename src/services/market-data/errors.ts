/**
 * Market Data Error Classification System
 *
 * 统一的错误类型系统，提供结构化的错误信息：
 * - code: 机器可读的错误代码
 * - provider: 错误来源（tradingview/yfinance/fmp 等）
 * - message: 人类可读的错误描述
 * - context: 额外的上下文信息
 */

export enum MarketDataErrorCode {
  // 参数错误（4xx）
  INVALID_ASSET_CLASS = 'INVALID_ASSET_CLASS',
  INVALID_SYMBOL = 'INVALID_SYMBOL',
  INVALID_ENDPOINT = 'INVALID_ENDPOINT',
  MISSING_REQUIRED_PARAM = 'MISSING_REQUIRED_PARAM',
  INVALID_PARAM_VALUE = 'INVALID_PARAM_VALUE',
  INVALID_FORMULA_SYNTAX = 'INVALID_FORMULA_SYNTAX',
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',

  // 认证错误（401/403）
  AUTHENTICATION_REQUIRED = 'AUTHENTICATION_REQUIRED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',

  // 数据源错误（5xx）
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  DATA_NOT_FOUND = 'DATA_NOT_FOUND',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // 网络错误
  NETWORK_ERROR = 'NETWORK_ERROR',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',

  // 内部错误
  PARSE_ERROR = 'PARSE_ERROR',
  CALCULATION_ERROR = 'CALCULATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface MarketDataErrorContext {
  endpoint?: string
  symbol?: string
  assetClass?: string
  provider?: string
  [key: string]: unknown
}

export class MarketDataError extends Error {
  public readonly code: MarketDataErrorCode
  public readonly provider: string
  public readonly context: MarketDataErrorContext
  public readonly timestamp: Date

  constructor(
    code: MarketDataErrorCode,
    message: string,
    provider: string = 'unknown',
    context: MarketDataErrorContext = {},
  ) {
    super(message)
    this.name = 'MarketDataError'
    this.code = code
    this.provider = provider
    this.context = context
    this.timestamp = new Date()

    // 保持正确的堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MarketDataError)
    }
  }

  /**
   * 转换为 envelope 格式的错误
   */
  toEnvelopeError(): string {
    return `[${this.code}] ${this.message}`
  }

  /**
   * 转换为结构化的错误对象
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
    }
  }

  /**
   * 判断是否为可重试的错误
   */
  isRetryable(): boolean {
    const retryableCodes = [
      MarketDataErrorCode.PROVIDER_TIMEOUT,
      MarketDataErrorCode.NETWORK_ERROR,
      MarketDataErrorCode.CONNECTION_TIMEOUT,
      MarketDataErrorCode.RATE_LIMIT_EXCEEDED,
    ]
    return retryableCodes.includes(this.code)
  }

  /**
   * 判断是否为客户端错误（用户可修复）
   */
  isClientError(): boolean {
    const clientCodes = [
      MarketDataErrorCode.INVALID_ASSET_CLASS,
      MarketDataErrorCode.INVALID_SYMBOL,
      MarketDataErrorCode.INVALID_ENDPOINT,
      MarketDataErrorCode.MISSING_REQUIRED_PARAM,
      MarketDataErrorCode.INVALID_PARAM_VALUE,
      MarketDataErrorCode.INVALID_FORMULA_SYNTAX,
      MarketDataErrorCode.LIMIT_EXCEEDED,
    ]
    return clientCodes.includes(this.code)
  }

  // 静态工厂方法

  static invalidAssetClass(assetClass: string, provider: string = 'unknown'): MarketDataError {
    return new MarketDataError(
      MarketDataErrorCode.INVALID_ASSET_CLASS,
      `Invalid asset class: ${assetClass}`,
      provider,
      { assetClass },
    )
  }

  static missingParam(param: string, endpoint: string, provider: string = 'unknown'): MarketDataError {
    return new MarketDataError(
      MarketDataErrorCode.MISSING_REQUIRED_PARAM,
      `${endpoint} requires params.${param}`,
      provider,
      { endpoint, param },
    )
  }

  static invalidFormula(formula: string, reason: string, provider: string = 'unknown'): MarketDataError {
    return new MarketDataError(
      MarketDataErrorCode.INVALID_FORMULA_SYNTAX,
      `Invalid formula syntax: ${reason}`,
      provider,
      { formula, reason },
    )
  }

  static providerTimeout(provider: string, timeoutMs: number, context: MarketDataErrorContext = {}): MarketDataError {
    return new MarketDataError(
      MarketDataErrorCode.PROVIDER_TIMEOUT,
      `${provider} request timed out after ${timeoutMs}ms`,
      provider,
      { ...context, timeoutMs },
    )
  }

  static authenticationRequired(provider: string, context: MarketDataErrorContext = {}): MarketDataError {
    return new MarketDataError(
      MarketDataErrorCode.AUTHENTICATION_REQUIRED,
      `${provider} requires authentication`,
      provider,
      context,
    )
  }

  static dataNotFound(symbol: string, provider: string = 'unknown', context: MarketDataErrorContext = {}): MarketDataError {
    return new MarketDataError(
      MarketDataErrorCode.DATA_NOT_FOUND,
      `No data found for symbol: ${symbol}`,
      provider,
      { ...context, symbol },
    )
  }

  static fromUnknown(error: unknown, provider: string = 'unknown', context: MarketDataErrorContext = {}): MarketDataError {
    if (error instanceof MarketDataError) {
      return error
    }

    if (error instanceof Error) {
      return new MarketDataError(
        MarketDataErrorCode.UNKNOWN_ERROR,
        error.message,
        provider,
        { ...context, originalError: error.name },
      )
    }

    return new MarketDataError(
      MarketDataErrorCode.UNKNOWN_ERROR,
      String(error),
      provider,
      context,
    )
  }
}
