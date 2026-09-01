/**
 * Market-vendor catalog — the agent-facing "what data sources do I have, and
 * how do I drive them" surface.
 *
 * Each vendor owns its self-description. Native OpenAlice vendors publish it
 * beside their adapter; compatibility providers publish `vendorMeta`. This module
 * JOINS that self-description to runtime state read fresh from market-data.json:
 *
 *   - alwaysOn  — is this the primary equity vendor (yfinance)? can't be toggled.
 *   - enabled   — always-on, or present in extraVendors.
 *   - keyless   — derived from the provider's declared credentials.
 *
 * `setMarketVendor` flips extraVendors; because the resolver re-reads config per
 * request, an agent that enables a vendor here can search it on the very next
 * call — no restart. This is the discoverability loop: list → read the usage
 * note → enable the one you need → query.
 */

import type { QueryExecutor } from '@traderalice/opentypebb'
import { readMarketDataConfig, updateExtraVendors } from '@/core/config.js'

export interface MarketVendorInfo {
  /** Vendor id used everywhere (search sourceId, setMarketVendor arg). */
  id: string
  /** Human display name. */
  name: string
  /** On right now — searches will fan out to it. */
  enabled: boolean
  /** The primary equity vendor: always on, cannot be toggled off. */
  alwaysOn: boolean
  /** No API key required. */
  keyless: boolean
  /** What markets / instruments it covers. */
  coverage: string
  /** How to drive it (symbol convention, search-language quirks). */
  howToUse: string
  website?: string
}

export interface MarketVendorDefinition {
  id: string
  name: string
  keyless: boolean
  coverage: string
  howToUse: string
  website?: string
}

function vendorDefinitions(
  executor: QueryExecutor,
  nativeVendors: readonly MarketVendorDefinition[],
): MarketVendorDefinition[] {
  const definitions = new Map<string, MarketVendorDefinition>()
  for (const provider of executor.listProviders()) {
    if (!provider.vendorMeta) continue
    definitions.set(provider.name, {
      id: provider.name,
      name: provider.reprName ?? provider.name,
      keyless: provider.credentials.length === 0,
      coverage: provider.vendorMeta.coverage,
      howToUse: provider.vendorMeta.howToUse,
      website: provider.website,
    })
  }
  for (const vendor of nativeVendors) definitions.set(vendor.id, vendor)
  return [...definitions.values()]
}

/** Native and compatibility vendors joined to current on/off state.
 *  Always-on first, then enabled, then the rest. */
export async function listMarketVendors(
  executor: QueryExecutor,
  nativeVendors: readonly MarketVendorDefinition[] = [],
): Promise<MarketVendorInfo[]> {
  const md = await readMarketDataConfig()
  const configuredProviders = new Set(Object.values(md.providers))
  const extra = new Set(md.extraVendors)

  return vendorDefinitions(executor, nativeVendors)
    .map((vendor): MarketVendorInfo => {
      const alwaysOn = configuredProviders.has(vendor.id)
      return {
        id: vendor.id,
        name: vendor.name,
        alwaysOn,
        enabled: Object.values(md.providers).includes(vendor.id) || extra.has(vendor.id),
        keyless: vendor.keyless,
        coverage: vendor.coverage,
        howToUse: vendor.howToUse,
        website: vendor.website,
      }
    })
    .sort(
      (a, b) =>
        Number(b.alwaysOn) - Number(a.alwaysOn) ||
        Number(b.enabled) - Number(a.enabled) ||
        a.id.localeCompare(b.id),
    )
}

export interface SetVendorResult {
  id: string
  enabled: boolean
  /** The full catalog after the change, so the caller sees the new state. */
  vendors: MarketVendorInfo[]
}

/**
 * Turn a vendor on/off and persist it. Takes effect on the next search (no
 * restart). Rejects unknown ids and the always-on primary.
 */
export async function setMarketVendor(
  executor: QueryExecutor,
  id: string,
  enabled: boolean,
  nativeVendors: readonly MarketVendorDefinition[] = [],
): Promise<SetVendorResult> {
  const known = vendorDefinitions(executor, nativeVendors)
  const target = known.find((vendor) => vendor.id.toLowerCase() === id.trim().toLowerCase())
  if (!target) {
    const names = known.map((vendor) => vendor.id).join(', ')
    throw new Error(`Unknown market vendor "${id}". Available vendors: ${names}.`)
  }

  const md = await readMarketDataConfig()
  const configuredAssetClass = Object.entries(md.providers)
    .find(([, provider]) => provider === target.id)?.[0]
  if (configuredAssetClass) {
    throw new Error(
      `"${target.id}" is the always-on configured provider for ${configuredAssetClass} and cannot be toggled.`,
    )
  }

  await updateExtraVendors((current) =>
    enabled ? [...current, target.id] : current.filter((v) => v !== target.id),
  )

  return { id: target.id, enabled, vendors: await listMarketVendors(executor, nativeVendors) }
}
