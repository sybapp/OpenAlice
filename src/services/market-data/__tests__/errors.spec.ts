import { describe, it, expect } from 'vitest'
import { MarketDataError, MarketDataErrorCode } from '../errors.js'

describe('MarketDataError', () => {
  describe('construction', () => {
    it('creates error with all properties', () => {
      const error = new MarketDataError(
        MarketDataErrorCode.INVALID_SYMBOL,
        'Invalid symbol',
        'yfinance',
        { symbol: 'INVALID' },
      )

      expect(error.code).toBe(MarketDataErrorCode.INVALID_SYMBOL)
      expect(error.message).toBe('Invalid symbol')
      expect(error.provider).toBe('yfinance')
      expect(error.context.symbol).toBe('INVALID')
      expect(error.timestamp).toBeInstanceOf(Date)
      expect(error.name).toBe('MarketDataError')
    })

    it('defaults to unknown provider', () => {
      const error = new MarketDataError(
        MarketDataErrorCode.UNKNOWN_ERROR,
        'Something went wrong',
      )

      expect(error.provider).toBe('unknown')
      expect(error.context).toEqual({})
    })
  })

  describe('toEnvelopeError', () => {
    it('formats error for envelope', () => {
      const error = new MarketDataError(
        MarketDataErrorCode.MISSING_REQUIRED_PARAM,
        'Missing param: symbol',
        'tradingview',
      )

      expect(error.toEnvelopeError()).toBe('[MISSING_REQUIRED_PARAM] Missing param: symbol')
    })
  })

  describe('toJSON', () => {
    it('serializes to structured object', () => {
      const error = new MarketDataError(
        MarketDataErrorCode.PROVIDER_TIMEOUT,
        'Timeout',
        'fmp',
        { timeoutMs: 5000 },
      )

      const json = error.toJSON()

      expect(json.name).toBe('MarketDataError')
      expect(json.code).toBe(MarketDataErrorCode.PROVIDER_TIMEOUT)
      expect(json.message).toBe('Timeout')
      expect(json.provider).toBe('fmp')
      expect(json.context.timeoutMs).toBe(5000)
      expect(typeof json.timestamp).toBe('string')
    })
  })

  describe('isRetryable', () => {
    it('returns true for retryable errors', () => {
      const retryable = [
        MarketDataErrorCode.PROVIDER_TIMEOUT,
        MarketDataErrorCode.NETWORK_ERROR,
        MarketDataErrorCode.CONNECTION_TIMEOUT,
        MarketDataErrorCode.RATE_LIMIT_EXCEEDED,
      ]

      retryable.forEach(code => {
        const error = new MarketDataError(code, 'test', 'test')
        expect(error.isRetryable()).toBe(true)
      })
    })

    it('returns false for non-retryable errors', () => {
      const nonRetryable = [
        MarketDataErrorCode.INVALID_SYMBOL,
        MarketDataErrorCode.AUTHENTICATION_REQUIRED,
        MarketDataErrorCode.DATA_NOT_FOUND,
      ]

      nonRetryable.forEach(code => {
        const error = new MarketDataError(code, 'test', 'test')
        expect(error.isRetryable()).toBe(false)
      })
    })
  })

  describe('isClientError', () => {
    it('returns true for client errors', () => {
      const clientErrors = [
        MarketDataErrorCode.INVALID_ASSET_CLASS,
        MarketDataErrorCode.INVALID_SYMBOL,
        MarketDataErrorCode.MISSING_REQUIRED_PARAM,
        MarketDataErrorCode.INVALID_FORMULA_SYNTAX,
      ]

      clientErrors.forEach(code => {
        const error = new MarketDataError(code, 'test', 'test')
        expect(error.isClientError()).toBe(true)
      })
    })

    it('returns false for server errors', () => {
      const serverErrors = [
        MarketDataErrorCode.PROVIDER_ERROR,
        MarketDataErrorCode.PROVIDER_TIMEOUT,
        MarketDataErrorCode.DATA_NOT_FOUND,
      ]

      serverErrors.forEach(code => {
        const error = new MarketDataError(code, 'test', 'test')
        expect(error.isClientError()).toBe(false)
      })
    })
  })

  describe('static factory methods', () => {
    it('creates invalidAssetClass error', () => {
      const error = MarketDataError.invalidAssetClass('invalid', 'yfinance')

      expect(error.code).toBe(MarketDataErrorCode.INVALID_ASSET_CLASS)
      expect(error.message).toContain('invalid')
      expect(error.context.assetClass).toBe('invalid')
    })

    it('creates missingParam error', () => {
      const error = MarketDataError.missingParam('symbol', '/equity/price', 'fmp')

      expect(error.code).toBe(MarketDataErrorCode.MISSING_REQUIRED_PARAM)
      expect(error.message).toContain('symbol')
      expect(error.context.param).toBe('symbol')
      expect(error.context.endpoint).toBe('/equity/price')
    })

    it('creates invalidFormula error', () => {
      const error = MarketDataError.invalidFormula('INVALID()', 'unknown function', 'indicator')

      expect(error.code).toBe(MarketDataErrorCode.INVALID_FORMULA_SYNTAX)
      expect(error.message).toContain('unknown function')
      expect(error.context.formula).toBe('INVALID()')
    })

    it('creates providerTimeout error', () => {
      const error = MarketDataError.providerTimeout('tradingview', 10000, { symbol: 'AAPL' })

      expect(error.code).toBe(MarketDataErrorCode.PROVIDER_TIMEOUT)
      expect(error.message).toContain('10000ms')
      expect(error.context.timeoutMs).toBe(10000)
      expect(error.context.symbol).toBe('AAPL')
    })

    it('creates authenticationRequired error', () => {
      const error = MarketDataError.authenticationRequired('tradingview')

      expect(error.code).toBe(MarketDataErrorCode.AUTHENTICATION_REQUIRED)
      expect(error.message).toContain('requires authentication')
    })

    it('creates dataNotFound error', () => {
      const error = MarketDataError.dataNotFound('UNKNOWN', 'yfinance')

      expect(error.code).toBe(MarketDataErrorCode.DATA_NOT_FOUND)
      expect(error.message).toContain('UNKNOWN')
      expect(error.context.symbol).toBe('UNKNOWN')
    })

    it('creates fromUnknown from MarketDataError', () => {
      const original = MarketDataError.invalidAssetClass('test', 'provider')
      const wrapped = MarketDataError.fromUnknown(original)

      expect(wrapped).toBe(original)
    })

    it('creates fromUnknown from standard Error', () => {
      const original = new Error('Standard error')
      const wrapped = MarketDataError.fromUnknown(original, 'provider')

      expect(wrapped.code).toBe(MarketDataErrorCode.UNKNOWN_ERROR)
      expect(wrapped.message).toBe('Standard error')
      expect(wrapped.provider).toBe('provider')
    })

    it('creates fromUnknown from unknown value', () => {
      const wrapped = MarketDataError.fromUnknown('string error', 'provider')

      expect(wrapped.code).toBe(MarketDataErrorCode.UNKNOWN_ERROR)
      expect(wrapped.message).toBe('string error')
    })
  })
})
