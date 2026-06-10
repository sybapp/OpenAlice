import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderRegistry } from '../provider-plugin.js'
import type { MarketDataProvider, ProviderQuery } from '../provider-plugin.js'
import type { MarketDataEnvelope } from '../types.js'

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
  })

  const createMockProvider = (name: string): MarketDataProvider => ({
    metadata: {
      name,
      description: `Mock ${name} provider`,
      capabilities: { search: true, historical: true },
      credentials: ['api_key'],
    },
    async query(input: ProviderQuery): Promise<MarketDataEnvelope> {
      return {
        provider: name,
        endpoint: input.endpoint,
        totalCount: 0,
        fields: [],
        rows: [],
        warnings: [],
      }
    },
  })

  describe('register', () => {
    it('registers a new provider', () => {
      const provider = createMockProvider('test-provider')
      registry.register(provider)

      expect(registry.has('test-provider')).toBe(true)
      expect(registry.get('test-provider')).toBe(provider)
    })

    it('throws when registering duplicate provider', () => {
      const provider = createMockProvider('test-provider')
      registry.register(provider)

      expect(() => registry.register(provider)).toThrow(
        "Provider 'test-provider' is already registered"
      )
    })
  })

  describe('unregister', () => {
    it('removes a provider', () => {
      const provider = createMockProvider('test-provider')
      registry.register(provider)

      const removed = registry.unregister('test-provider')
      expect(removed).toBe(true)
      expect(registry.has('test-provider')).toBe(false)
    })

    it('returns false when provider does not exist', () => {
      const removed = registry.unregister('nonexistent')
      expect(removed).toBe(false)
    })
  })

  describe('get', () => {
    it('returns registered provider', () => {
      const provider = createMockProvider('test-provider')
      registry.register(provider)

      expect(registry.get('test-provider')).toBe(provider)
    })

    it('returns undefined for unregistered provider', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns metadata of all providers', () => {
      registry.register(createMockProvider('provider-a'))
      registry.register(createMockProvider('provider-b'))

      const list = registry.list()
      expect(list).toHaveLength(2)
      expect(list.map(p => p.name)).toEqual(['provider-a', 'provider-b'])
    })

    it('returns empty array when no providers', () => {
      expect(registry.list()).toEqual([])
    })
  })

  describe('has', () => {
    it('returns true for registered provider', () => {
      registry.register(createMockProvider('test-provider'))
      expect(registry.has('test-provider')).toBe(true)
    })

    it('returns false for unregistered provider', () => {
      expect(registry.has('nonexistent')).toBe(false)
    })
  })

  describe('clear', () => {
    it('removes all providers', () => {
      registry.register(createMockProvider('provider-a'))
      registry.register(createMockProvider('provider-b'))

      registry.clear()

      expect(registry.list()).toEqual([])
      expect(registry.has('provider-a')).toBe(false)
      expect(registry.has('provider-b')).toBe(false)
    })
  })

  describe('provider query', () => {
    it('calls provider query method', async () => {
      const provider = createMockProvider('test-provider')
      registry.register(provider)

      const result = await provider.query({
        endpoint: '/equity/price/quote',
        params: { symbol: 'AAPL' },
      })

      expect(result.provider).toBe('test-provider')
      expect(result.endpoint).toBe('/equity/price/quote')
    })
  })
})
