import type { BarSourceRef } from '@/domain/market-data/bars/index.js'
import type { AssetClass } from '@/domain/market-data/aggregate-search.js'

export function sourceRef(source: { barId: string; assetClass?: AssetClass }): BarSourceRef {
  return source.assetClass ? { barId: source.barId, assetClass: source.assetClass } : { barId: source.barId }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
