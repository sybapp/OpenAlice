import type {
  BarMeta,
  BarService,
  BarSourceRef,
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

function sourceRef(source: TechnicalAnalysisSourceRequest): BarSourceRef {
  return source.assetClass ? { barId: source.barId, assetClass: source.assetClass } : { barId: source.barId }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  if (!orderFlow.delta) {
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
    profile: null,
    delta: {
      bars: orderFlow.delta.bars.slice(-5).map((bar) => ({
        timestamp: bar.timestamp,
        close: bar.close,
        delta: bar.delta,
        deltaRatio: bar.deltaRatio,
        cvd: bar.cvd,
      } as unknown as typeof bar)),
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
  const getBarsOptions: GetBarsOpts = {
    interval,
    count: params.count ?? 200,
    start: params.start,
    end: params.end,
  }

  try {
    const loaded = await barService.getBars(ref, getBarsOptions)
    if (loaded.bars.length < 3) {
      return {
        interval,
        status: 'insufficient',
        priceAction: emptyPriceAction(interval, loaded.meta, loaded.bars),
        meta: loaded.meta,
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
      count: loaded.bars.length,
      start: params.start,
      end: params.end,
      mode: 'context',
      numBins: params.numBins,
      targetBars: loaded.bars,
      targetMeta: loaded.meta,
    })
    const atrPeriod = params.indicators?.atrPeriod ?? 200
    const volatilityBars = loaded.bars.length >= atrPeriod
      ? loaded.bars
      : (await barService.getBars(ref, {
        interval,
        count: atrPeriod,
        start: params.start,
        end: params.end,
      })).bars
    const priceAction = await analyzePriceActionLoadedBars(
      barService,
      ref,
      {
        barId: params.barId,
        assetClass: params.assetClass,
        interval,
        count: params.count,
        start: params.start,
        end: params.end,
        options: priceActionOptions,
        volatilityBars,
      },
      loaded.bars,
      loaded.meta,
      volumeConfirmationsFromOrderFlow(orderFlow),
    )
    const indicators = buildTechnicalAnalysisIndicators(
      loaded.bars,
      priceAction.marketStructure,
      params.indicators,
      volatilityBars,
    )

    return {
      interval,
      status: 'ok',
      summary: intervalSummary(loaded.bars, indicators, priceAction, orderFlow),
      indicators,
      priceAction,
      orderFlow: compactOrderFlow(orderFlow, mode),
      meta: loaded.meta,
    }
  } catch (error) {
    return {
      interval,
      status: 'error',
      error: errorMessage(error),
    }
  }
}
