import { structureVolumePriceStrategy } from './strategies/structure-volume-price/index.js'
import { hashSignalEngineStrategyManifest, type SeedSignalEngineStrategyInput } from './strategy-store.js'
import type { StrategyPlugin } from './types.js'

export interface BuiltInSignalEngineStrategyDescriptor {
  id: string
  version: string
  plugin: StrategyPlugin
  manifest: Record<string, unknown>
  pluginHash: string
}

function descriptor(input: {
  plugin: StrategyPlugin
  manifest: Record<string, unknown>
}): BuiltInSignalEngineStrategyDescriptor {
  return {
    id: input.plugin.id,
    version: input.plugin.version,
    plugin: input.plugin,
    manifest: input.manifest,
    pluginHash: hashSignalEngineStrategyManifest(input.manifest),
  }
}

const BUILT_IN_SIGNAL_ENGINE_STRATEGIES: BuiltInSignalEngineStrategyDescriptor[] = [
  descriptor({
    plugin: structureVolumePriceStrategy,
    manifest: {
      kind: 'builtin',
      family: 'structure-volume-price',
      evaluate: {
        lookbackMinBars: 8,
        orderType: 'LMT',
      },
      notes: 'Deterministic closed-bar strategy with structure breakout and volume confirmation.',
    },
  }),
]

export function listBuiltInSignalEngineStrategies(): BuiltInSignalEngineStrategyDescriptor[] {
  return BUILT_IN_SIGNAL_ENGINE_STRATEGIES.map((entry) => ({ ...entry, manifest: { ...entry.manifest } }))
}

export function toStrategySeed(entries: BuiltInSignalEngineStrategyDescriptor[]): SeedSignalEngineStrategyInput[] {
  return entries.map((entry) => ({
    id: entry.id,
    version: entry.version,
    manifest: entry.manifest,
    pluginHash: entry.pluginHash,
  }))
}
