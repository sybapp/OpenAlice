import type { MarketDataEnvelope } from './types.js'

export interface ProviderCapabilities {
  search?: boolean
  historical?: boolean
  quote?: boolean
  scan?: boolean
  fundamental?: boolean
}

export interface ProviderMetadata {
  name: string
  description: string
  capabilities: ProviderCapabilities
  credentials?: string[]
}

export interface ProviderQuery {
  endpoint: string
  params: Record<string, unknown>
  credentials?: Record<string, string>
}

export interface MarketDataProvider {
  readonly metadata: ProviderMetadata
  query(input: ProviderQuery): Promise<MarketDataEnvelope>
}

export class ProviderRegistry {
  private providers = new Map<string, MarketDataProvider>()

  register(provider: MarketDataProvider): void {
    if (this.providers.has(provider.metadata.name)) {
      throw new Error(`Provider '${provider.metadata.name}' is already registered`)
    }
    this.providers.set(provider.metadata.name, provider)
  }

  unregister(name: string): boolean {
    return this.providers.delete(name)
  }

  get(name: string): MarketDataProvider | undefined {
    return this.providers.get(name)
  }

  list(): ProviderMetadata[] {
    return Array.from(this.providers.values()).map(p => p.metadata)
  }

  has(name: string): boolean {
    return this.providers.has(name)
  }

  clear(): void {
    this.providers.clear()
  }
}

export const globalRegistry = new ProviderRegistry()
