import { z } from 'zod'
import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import { analyzePriceActionBars, type AnalyzePriceActionBarsOptions, type PriceActionAnalysisResult } from './analyze.js'
import type { PriceActionVolumeConfirmationInput } from './types.js'

export type PriceActionContextMode = 'context' | 'execution' | 'debug'

const zoneMitigationSourceSchema = z.enum(['body', 'wick', 'midpoint'])
const overlapPolicySchema = z.enum(['ranked', 'older', 'newer', 'none'])
const structureLevelSchema = z.enum(['internal', 'swing', 'external'])

export const priceActionOptionsSchema: z.ZodType<AnalyzePriceActionBarsOptions> = z.object({
  gapMode: z.enum(['FVG', 'VI', 'OG', 'all']).optional(),
  zoneMitigationSource: zoneMitigationSourceSchema.optional(),
  fvgZoneMitigationSource: zoneMitigationSourceSchema.optional(),
  orderBlockZoneMitigationSource: zoneMitigationSourceSchema.optional(),
  gapVolumeConfirmation: z.boolean().optional(),
  minGapAtrMultiplier: z.number().nonnegative().optional(),
  minBodyRatio: z.number().optional(),
  maxFVGs: z.number().int().min(0).optional(),
  maxIFVGs: z.number().int().min(0).optional(),
  includeFilled: z.boolean().optional(),
  proximityPct: z.number().nonnegative().optional(),
  maxIFVGLookAheadBars: z.number().int().positive().optional(),
  ifvgVolumeConfirmation: z.boolean().optional(),
  minImpulseRatio: z.number().nonnegative().optional(),
  minEngulfingStrength: z.number().nonnegative().optional(),
  maxOrderBlocks: z.number().int().min(0).optional(),
  includeMitigatedOrderBlocks: z.boolean().optional(),
  orderBlockTrigger: z.enum(['all', 'BOS', 'CHoCH']).optional(),
  orderBlockPosition: z.enum(['full', 'middle', 'accurate', 'precise']).optional(),
  overlapPolicy: overlapPolicySchema.optional(),
  orderBlockVolumeConfirmation: z.boolean().optional(),
  internalLookback: z.number().int().min(2).optional(),
  swingLookback: z.number().int().min(2).optional(),
  externalLookback: z.number().int().min(2).optional(),
  marketStructureMode: z.enum(['pivot', 'extreme']).optional(),
  liquidityPoolToleranceAtrMultiplier: z.number().nonnegative().optional(),
  liquidityPoolTolerancePctCap: z.number().nonnegative().optional(),
  minLiquidityPoolTouches: z.number().int().min(2).optional(),
  liquidityPoolLevels: z.array(structureLevelSchema).min(1).optional(),
}).strict()

export interface AnalyzePriceActionRuntimeParams {
  barId: string
  assetClass?: 'equity' | 'crypto' | 'currency' | 'commodity'
  interval: string
  options?: AnalyzePriceActionBarsOptions
  volatilityBars?: OhlcvBar[]
}

export type PriceActionAnalyzeDefaults = Pick<
  AnalyzePriceActionBarsOptions,
  'gapVolumeConfirmation' | 'ifvgVolumeConfirmation' | 'orderBlockVolumeConfirmation' | 'maxFVGs' | 'maxIFVGs' | 'maxOrderBlocks'
>

export function buildAnalyzeOptions(
  input: AnalyzePriceActionBarsOptions = {},
  defaults: PriceActionAnalyzeDefaults,
): AnalyzePriceActionBarsOptions {
  return {
    ...input,
    gapMode: input.gapMode ?? 'FVG',
    zoneMitigationSource: input.zoneMitigationSource ?? 'body',
    gapVolumeConfirmation: input.gapVolumeConfirmation ?? defaults.gapVolumeConfirmation,
    maxFVGs: input.maxFVGs ?? defaults.maxFVGs,
    maxIFVGs: input.maxIFVGs ?? defaults.maxIFVGs,
    includeFilled: input.includeFilled ?? false,
    ifvgVolumeConfirmation: input.ifvgVolumeConfirmation ?? defaults.ifvgVolumeConfirmation,
    maxOrderBlocks: input.maxOrderBlocks ?? defaults.maxOrderBlocks,
    includeMitigatedOrderBlocks: input.includeMitigatedOrderBlocks ?? false,
    orderBlockTrigger: input.orderBlockTrigger ?? 'all',
    orderBlockPosition: input.orderBlockPosition ?? 'precise',
    orderBlockVolumeConfirmation: input.orderBlockVolumeConfirmation ?? defaults.orderBlockVolumeConfirmation,
  }
}

export function priceActionContextDefaults(mode: PriceActionContextMode = 'context'): {
  defaults: PriceActionAnalyzeDefaults
  options: AnalyzePriceActionBarsOptions
} {
  if (mode === 'execution') {
    return {
      defaults: {
        gapVolumeConfirmation: true,
        ifvgVolumeConfirmation: true,
        orderBlockVolumeConfirmation: true,
        maxFVGs: 6,
        maxIFVGs: 4,
        maxOrderBlocks: 6,
      },
      options: {
        proximityPct: 0.05,
      },
    }
  }

  if (mode === 'debug') {
    return {
      defaults: {
        gapVolumeConfirmation: true,
        ifvgVolumeConfirmation: true,
        orderBlockVolumeConfirmation: true,
        maxFVGs: 10,
        maxIFVGs: 5,
        maxOrderBlocks: 10,
      },
      options: {},
    }
  }

  return {
    defaults: {
      gapVolumeConfirmation: false,
      ifvgVolumeConfirmation: false,
      orderBlockVolumeConfirmation: false,
      maxFVGs: 5,
      maxIFVGs: 3,
      maxOrderBlocks: 5,
    },
    options: {},
  }
}

export async function analyzePriceActionLoadedBars(
  params: AnalyzePriceActionRuntimeParams,
  bars: OhlcvBar[],
  meta: object,
  loadedVolumeConfirmations?: {
    confirmations?: Map<number, PriceActionVolumeConfirmationInput>
    meta?: object
  },
): Promise<PriceActionAnalysisResult> {
  const volumeConfirmation = loadedVolumeConfirmations ?? { confirmations: undefined, meta: {} }

  return analyzePriceActionBars({
    bars,
    interval: params.interval,
    meta,
    options: params.options,
    volumeConfirmations: volumeConfirmation.confirmations,
    volumeConfirmationMeta: volumeConfirmation.meta ?? {},
    volatilityBars: params.volatilityBars,
  })
}
