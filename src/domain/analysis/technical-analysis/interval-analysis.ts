import type {
  BarMeta,
  BarService,
  GetBarsOpts,
  OhlcvBar,
} from '@/domain/market-data/bars/index.js'
import { analyzeOrderFlowContext, type OrderFlowContextAnalysis } from './order-flow/context.js'
import {
  analyzePriceActionBars,
  type PriceActionAnalysisResult,
} from './price-action/analyze.js'
import {
  analyzePriceActionLoadedBars,
  buildAnalyzeOptions,
  priceActionContextDefaults,
} from './price-action/context.js'
import type { TrendDirection } from './price-action/types.js'
import { toSignedVolumeEvidence } from './order-flow/volume-evidence.js'
import type { SignedVolumeEvidence } from './order-flow/volume-evidence.js'
import {
  buildTechnicalAnalysisIndicators,
  type TechnicalAnalysisIndicatorResult,
} from './indicators.js'
import type {
  AnalyzeTechnicalAnalysisParams,
  TechnicalAnalysisIntervalResult,
  TechnicalAnalysisIntervalSummary,
  TechnicalAnalysisMode,
  TechnicalAnalysisSourceRequest,
} from './context.js'
import { errorMessage, sourceRef } from './shared.js'

function dominantTrend(priceAction: PriceActionAnalysisResult): TrendDirection {
  const trends = [
    priceAction.marketStructure.stateByLevel.external.trend,
    priceAction.marketStructure.stateByLevel.swing.trend,
    priceAction.marketStructure.stateByLevel.internal.trend,
  ]
  const bullish = trends.filter((trend) => trend === 'bullish').length
  const bearish = trends.filter((trend) => trend === 'bearish').length
  if (bullish > bearish) return 'bullish'
  if (bearish > bullish) return 'bearish'
  return 'unknown'
}

function volumeConfirmationsFromOrderFlow(orderFlow: OrderFlowContextAnalysis): {
  confirmations?: Map<number, SignedVolumeEvidence>
  meta: Record<string, unknown>
} {
  if (!orderFlow.delta?.bars.length) {
    return {
      meta: {
        volumeConfirmation: 'unavailable',
        ...(orderFlow.error ? { volumeConfirmationReason: orderFlow.error } : {}),
        volumeConfirmationIntrabarInterval: orderFlow.meta.intrabarInterval,
        volumeConfirmationIntrabarCount: orderFlow.meta.intrabarCount,
      },
    }
  }

  const confirmations = new Map<number, SignedVolumeEvidence>()
  for (let index = 0; index < orderFlow.delta.bars.length; index += 1) {
    const bar = orderFlow.delta.bars[index]!
    confirmations.set(
      orderFlow.meta.targetIndexOffset + index,
      toSignedVolumeEvidence(bar, orderFlow.meta.intrabarInterval, orderFlow.meta.intrabarCount),
    )
  }
  return {
    confirmations,
    meta: {
      volumeConfirmation: 'available',
      volumeConfirmationCoverageBars: orderFlow.delta.bars.length,
      volumeConfirmationLowConfidenceBars: orderFlow.meta.lowConfidenceBars,
      volumeConfirmationIntrabarInterval: orderFlow.meta.intrabarInterval,
      volumeConfirmationIntrabarCount: orderFlow.meta.intrabarCount,
      ...(orderFlow.meta.degradationReason
        ? { volumeConfirmationReason: orderFlow.meta.degradationReason }
        : {}),
    },
  }
}

function compactOrderFlow(orderFlow: OrderFlowContextAnalysis, mode: TechnicalAnalysisMode): OrderFlowContextAnalysis {
  if (mode === 'debug') return orderFlow
  const { profile: _profile, ...compact } = orderFlow
  if (mode !== 'execution' || !orderFlow.delta) {
    const { delta: _delta, ...withoutDelta } = compact
    return withoutDelta
  }
  return {
    ...compact,
    delta: {
      bars: orderFlow.delta.bars.slice(-5),
    },
  }
}

function intervalSummary(
  bars: OhlcvBar[],
  indicators: TechnicalAnalysisIndicatorResult,
  priceAction: PriceActionAnalysisResult,
  orderFlow: OrderFlowContextAnalysis,
): TechnicalAnalysisIntervalSummary {
  return {
    price: bars.at(-1)?.close,
    trend: dominantTrend(priceAction),
    emaBias: indicators.ema.bias,
    vwapRelation: indicators.vwap?.relation ?? 'unavailable',
    ...(indicators.confluence?.score === undefined ? {} : { confluenceScore: indicators.confluence.score }),
    confluenceZoneCount: indicators.confluenceZones.length,
    fvgCount: priceAction.fvgs.length,
    misalignedFvgCount: priceAction.fvgs.filter((fvg) => fvg.qualityFlag === 'misaligned_with_pattern').length,
    ifvgCount: priceAction.ifvgs.length,
    orderBlockCount: priceAction.orderBlocks.length,
    liquidityPoolCount: priceAction.liquidityPools.length,
    orderFlowStatus: orderFlow.status,
    warnings: [
      ...indicators.warnings,
      ...(orderFlow.error ? [`Order-flow context: ${orderFlow.error}`] : []),
      ...(priceAction.fvgs.some((fvg) => fvg.qualityFlag === 'misaligned_with_pattern')
        ? ['FVG volume is misaligned with the pattern direction']
        : []),
      ...(priceAction.meta.volatility.atrWindowBars !== undefined
        && priceAction.meta.volatility.atrWindowBars < priceAction.meta.volatility.period
        ? [`ATR uses ${priceAction.meta.volatility.atrWindowBars} bars, below its ${priceAction.meta.volatility.period}-bar period; structure thresholds are window-sensitive`]
        : []),
    ],
  }
}

function emptyPriceAction(interval: string, meta: BarMeta, bars: OhlcvBar[]): PriceActionAnalysisResult {
  return analyzePriceActionBars({ bars, interval, meta })
}

export async function analyzeTechnicalAnalysisInterval(
  barService: BarService,
  params: AnalyzeTechnicalAnalysisParams,
  interval: string,
  mode: TechnicalAnalysisMode,
): Promise<TechnicalAnalysisIntervalResult> {
  const ref = sourceRef(params)
  const requestedCount = params.count ?? 200
  const atrPeriod = params.indicators?.atrPeriod ?? 200
  const getBarsOptions: GetBarsOpts = {
    interval,
    count: Math.max(requestedCount, atrPeriod),
    start: params.start,
    end: params.end,
  }

  try {
    const loaded = await barService.getBars(ref, getBarsOptions)
    const targetBars = loaded.bars.slice(-requestedCount)
    const targetMeta: BarMeta = {
      ...loaded.meta,
      from: targetBars[0]?.date ?? loaded.meta.from,
      to: targetBars.at(-1)?.date ?? loaded.meta.to,
      bars: targetBars.length,
    }
    if (targetBars.length < 3) {
      return {
        interval,
        status: 'insufficient',
        priceAction: emptyPriceAction(interval, targetMeta, targetBars),
        meta: targetMeta,
        error: 'Insufficient bars returned for technical analysis',
      }
    }

    const priceActionPreset = priceActionContextDefaults(mode)
    const priceActionOptions = buildAnalyzeOptions(
      { ...priceActionPreset.options, ...params.priceAction },
      priceActionPreset.defaults,
    )
    const orderFlow = await analyzeOrderFlowContext(barService, {
      barId: params.barId,
      assetClass: params.assetClass,
      interval,
      count: targetBars.length,
      start: params.start,
      end: params.end,
      numBins: params.numBins,
      targetBars,
      targetMeta,
    })
    const priceAction = await analyzePriceActionLoadedBars(
      {
        barId: params.barId,
        assetClass: params.assetClass,
        interval,
        options: priceActionOptions,
        volatilityBars: loaded.bars,
      },
      targetBars,
      targetMeta,
      volumeConfirmationsFromOrderFlow(orderFlow),
    )
    const indicators = buildTechnicalAnalysisIndicators(
      targetBars,
      priceAction.marketStructure,
      params.indicators,
      loaded.bars,
    )

    return {
      interval,
      status: 'ok',
      summary: intervalSummary(targetBars, indicators, priceAction, orderFlow),
      indicators,
      priceAction,
      orderFlow: compactOrderFlow(orderFlow, mode),
      meta: targetMeta,
    }
  } catch (error) {
    return {
      interval,
      status: 'error',
      error: errorMessage(error),
    }
  }
}
