import { canonicalSha256 } from '../../canonical-json.js'
import type { ReplayBar, SignalEngineSignal, StrategyContext, StrategyPlugin } from '../../types.js'

export const structureVolumePriceStrategy: StrategyPlugin = {
  id: 'structure-volume-price',
  version: '1',
  evaluate(history, context) {
    if (history.length < 8) return []
    const index = history.length - 1
    const current = history[index]
    const previous = history[index - 1]
    const prior = history.slice(0, -1)
    const lookback = prior.slice(-6)
    const priorHigh = Math.max(...lookback.map((bar) => decimal(bar.high)))
    const priorLow = Math.min(...lookback.map((bar) => decimal(bar.low)))
    const close = decimal(current.close)
    const open = decimal(current.open)
    const direction: 'bullish' | 'bearish' | null = close > priorHigh ? 'bullish' : close < priorLow ? 'bearish' : null
    if (!direction) return []

    const volumeScore = computeVolumeScore(history)
    if (volumeScore < 0.8) return []

    const vwap = computeVwap(history.slice(-20))
    const liquidity = detectLiquiditySweep(current, priorHigh, priorLow)
    const zone = detectFairValueGap(history) ?? detectOrderBlock(history, direction)
    const stopLossPrice = direction === 'bullish'
      ? Math.min(decimal(current.low), priorLow)
      : Math.max(decimal(current.high), priorHigh)
    if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) return []

    const lmtPrice = close
    const takeProfit = projectTakeProfit(lmtPrice, stopLossPrice, direction)
    const signalBase = {
      kind: 'structure_volume_price' as const,
      label: `${direction} BOS volume-price`,
      message: `${context.symbol} ${context.interval} ${direction} structure break with volume score ${format(volumeScore)}.`,
      direction,
      closedBarTime: current.time,
      index,
      lmtPrice: format(lmtPrice),
      stopLoss: { price: format(stopLossPrice) },
      ...(takeProfit ? { takeProfit: { price: format(takeProfit) } } : {}),
      order: {
        orderType: 'LMT' as const,
        action: direction === 'bullish' ? 'BUY' as const : 'SELL' as const,
        lmtPrice: format(lmtPrice),
        stopLoss: { price: format(stopLossPrice) },
        ...(takeProfit ? { takeProfit: { price: format(takeProfit) } } : {}),
      },
      features: {
        structure: close > priorHigh ? 'BOS' : close < priorLow ? 'BOS' : 'MSS',
        ...(zone ? { zone } : {}),
        ...(liquidity ? { liquidity } : {}),
        volumeScore: format(volumeScore),
        vwap: format(vwap || (open + close) / 2),
      },
    }
    const sourceHash = canonicalSha256({
      strategyId: 'structure-volume-price',
      strategyVersion: '1',
      bar: current,
      previous,
      features: signalBase.features,
    })
    const canonicalPayloadHash = canonicalSha256(signalBase)
    const id = `sig_${canonicalPayloadHash.slice(0, 24)}`
    return [{ id, ...signalBase, sourceHash, canonicalPayloadHash }]
  },
}

function computeVolumeScore(history: ReplayBar[]): number {
  const current = decimal(history.at(-1)?.volume ?? '0')
  const baseline = history.slice(-21, -1).map((bar) => decimal(bar.volume)).filter((v) => v > 0)
  if (baseline.length === 0) return 1
  const average = baseline.reduce((sum, value) => sum + value, 0) / baseline.length
  return average > 0 ? current / average : 1
}

function computeVwap(history: ReplayBar[]): number {
  let pv = 0
  let volume = 0
  for (const bar of history) {
    const v = decimal(bar.volume)
    const typical = (decimal(bar.high) + decimal(bar.low) + decimal(bar.close)) / 3
    if (v > 0) {
      pv += typical * v
      volume += v
    }
  }
  return volume > 0 ? pv / volume : decimal(history.at(-1)?.close ?? '0')
}

function detectLiquiditySweep(current: ReplayBar, priorHigh: number, priorLow: number): string | null {
  const high = decimal(current.high)
  const low = decimal(current.low)
  const close = decimal(current.close)
  if (high > priorHigh && close < priorHigh) return 'buy-side sweep'
  if (low < priorLow && close > priorLow) return 'sell-side sweep'
  return null
}

function detectFairValueGap(history: ReplayBar[]): string | null {
  const a = history.at(-3)
  const c = history.at(-1)
  if (!a || !c) return null
  if (decimal(c.low) > decimal(a.high)) return 'bullish FVG'
  if (decimal(c.high) < decimal(a.low)) return 'bearish FVG'
  return null
}

function detectOrderBlock(history: ReplayBar[], direction: 'bullish' | 'bearish'): string | null {
  const prior = history.slice(-6, -1).reverse()
  const opposite = prior.find((bar) => direction === 'bullish'
    ? decimal(bar.close) < decimal(bar.open)
    : decimal(bar.close) > decimal(bar.open))
  return opposite ? `${direction} OB ${opposite.time}` : null
}

function projectTakeProfit(entry: number, stop: number, direction: 'bullish' | 'bearish'): number | null {
  const risk = Math.abs(entry - stop)
  if (!Number.isFinite(risk) || risk <= 0) return null
  return direction === 'bullish' ? entry + risk * 2 : entry - risk * 2
}

function decimal(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function format(value: number): string {
  return Number(value.toFixed(8)).toString()
}
