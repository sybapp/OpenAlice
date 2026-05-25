import type { TechnicalAnalysisAnalysis, TechnicalAnalysisCandle, TechnicalAnalysisOptions } from './types.js'
import { normalizeOptions } from './options.js'
import { emptyAnalysis, normalizeCandles } from './candles.js'
import { buildPremiumDiscount, buildStrongWeakLevels, detectAccumulationDistribution, detectEqualHighLows, detectPivots, detectStructureEvents, inferTrend } from './structure.js'
import { detectBalancePriceRanges, detectFairValueGaps, detectLiquidityZones, detectOrderBlocks } from './zones.js'
import { buildConfluenceSeries, detectConfluenceZones, detectFibRetracements } from './confluence.js'
import { buildVolumePriceSignals, detectStopZones, detectUnusualVolumeSignals, detectVolumeProfiles, detectVwapDeviation } from './volume.js'
import { buildRelevance } from './relevance.js'

export class TechnicalAnalysisAnalyzer {
  analyze(rawCandles: TechnicalAnalysisCandle[], options: TechnicalAnalysisOptions = {}): TechnicalAnalysisAnalysis {
    const normalized = normalizeOptions(options)
    const warnings: string[] = []
    const candles = normalizeCandles(rawCandles, warnings)
    const hasVolume = candles.some((candle) => typeof candle.volume === 'number' && Number.isFinite(candle.volume))

    if (!hasVolume) warnings.push('Volume is unavailable; volume-price confirmations are omitted.')
    if (candles.length === 0) return emptyAnalysis(warnings)

    const pivots = [
      ...detectPivots(candles, normalized.internalLookback, 'internal'),
      ...detectPivots(candles, normalized.swingLookback, 'swing'),
    ].sort((a, b) => a.index - b.index || a.level.localeCompare(b.level) || a.kind.localeCompare(b.kind))

    const internalEvents = detectStructureEvents(candles, pivots.filter((pivot) => pivot.level === 'internal'), 'internal', normalized)
    const swingEvents = detectStructureEvents(candles, pivots.filter((pivot) => pivot.level === 'swing'), 'swing', normalized)
    const structureEvents = [...internalEvents, ...swingEvents]
      .sort((a, b) => a.index - b.index)
      .slice(-normalized.limits.maxStructureEvents)
    const orderBlocks = detectOrderBlocks(candles, structureEvents, normalized).slice(-normalized.limits.maxOrderBlocks)
    const fairValueGaps = detectFairValueGaps(candles, normalized, hasVolume).slice(-normalized.limits.maxFairValueGaps)
    const liquidityZones = detectLiquidityZones(candles, pivots.filter((pivot) => pivot.level === 'swing'), normalized)
      .slice(-normalized.limits.maxLiquidityZones)
    const balancePriceRanges = detectBalancePriceRanges(candles, fairValueGaps, normalized.bpr)
      .slice(-normalized.limits.maxBalancePriceRanges)
    const fibRetracements = detectFibRetracements(candles, pivots, structureEvents, normalized)
    const volumeProfiles = detectVolumeProfiles(candles, normalized, hasVolume)
    const stopZones = detectStopZones(candles, normalized, hasVolume)
    const equalHighLows = detectEqualHighLows(candles, normalized)
    const accumulationDistributionZones = detectAccumulationDistribution(pivots.filter((pivot) => pivot.level === 'internal'), normalized)
    const premiumDiscount = buildPremiumDiscount(pivots.filter((pivot) => pivot.level === 'swing'))
    const strongWeakLevels = buildStrongWeakLevels(candles, pivots.filter((pivot) => pivot.level === 'swing'), swingEvents)
    const confluence = buildConfluenceSeries(candles, structureEvents, normalized)
    const vwapDeviation = detectVwapDeviation(candles, structureEvents, normalized)
    const unusualVolumeSignals = detectUnusualVolumeSignals(candles, normalized, hasVolume)
    const confluenceZones = detectConfluenceZones(candles, fibRetracements, confluence.latest, normalized)
    const volumePriceSignals = buildVolumePriceSignals(
      candles,
      structureEvents,
      orderBlocks,
      fairValueGaps,
      liquidityZones,
      balancePriceRanges,
      volumeProfiles,
      stopZones,
      vwapDeviation.signals,
      unusualVolumeSignals,
      normalized,
      hasVolume,
      confluence.byIndex,
    ).slice(-normalized.limits.maxVolumeSignals)
    const internalTrend = inferTrend(internalEvents)
    const swingTrend = inferTrend(swingEvents)
    const trend = swingTrend === 'neutral' ? internalTrend : swingTrend
    const relevance = buildRelevance(candles, orderBlocks, fairValueGaps, liquidityZones, balancePriceRanges, confluenceZones, normalized)
    const unusualVolumeSignalsCount = volumePriceSignals.filter((signal) => signal.kind === 'unusual_volume').length
    const vwapDeviationSignalsCount = volumePriceSignals.filter((signal) => signal.kind === 'vwap_deviation').length
    const ifvgZones = fairValueGaps.filter((gap) => gap.mode === 'IFVG').length

    return {
      summary: {
        candles: candles.length,
        trend,
        internalTrend,
        swingTrend,
        latestClose: candles.at(-1)?.close,
        structureEvents: structureEvents.length,
        orderBlocks: orderBlocks.length,
        fairValueGaps: fairValueGaps.length,
        liquidityZones: liquidityZones.length,
        balancePriceRanges: balancePriceRanges.length,
        fibRetracements: fibRetracements.length,
        confluenceZones: confluenceZones.length,
        volumeProfiles: volumeProfiles.length,
        stopZones: stopZones.length,
        unusualVolumeSignals: unusualVolumeSignalsCount,
        vwapDeviationSignals: vwapDeviationSignalsCount,
        ifvgZones,
        equalHighLows: equalHighLows.length,
        accumulationDistributionZones: accumulationDistributionZones.length,
        confluence: confluence.latest,
        vwapDeviation: vwapDeviation.latest,
        warnings,
      },
      pivots,
      structureEvents,
      orderBlocks,
      fairValueGaps,
      liquidityZones,
      balancePriceRanges,
      fibRetracements,
      confluenceZones,
      volumeProfiles,
      stopZones,
      equalHighLows,
      accumulationDistributionZones,
      premiumDiscount,
      strongWeakLevels,
      vwapDeviation: vwapDeviation.latest,
      volumePriceSignals,
      relevance,
      warnings,
    }
  }
}
