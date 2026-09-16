/**
 * Stable signal identities for `watch` evaluation.
 *
 * Array indices drift when the loaded window slides (a restart or a longer
 * history shifts every `index`), so trigger dedup must never use a raw index.
 * Identities here are built from bar dates + prices + level/kind, which are
 * stable as long as the source bars are.
 */

import type { OhlcvBar } from '@/domain/market-data/bars/types.js'
import type {
  FairValueGap,
  OrderBlock,
  StructureBreakEvent,
} from '../price-action/types.js'

function barDate(bars: readonly OhlcvBar[], index: number | undefined): string {
  if (index === undefined || !Number.isInteger(index)) return 'unknown'
  return bars[index]?.date ?? `index:${index}`
}

/** Keep existing default signal ids stable; namespace additional contexts. */
export function sourceSignalId(source: string, signalId: string): string {
  return source === 'default' ? signalId : `${source}|${signalId}`
}

/** Stable id for a BOS/CHoCH event. `kind` is the array it came from — the
 * event itself does not carry it. */
export function structureBreakId(
  kind: 'BOS' | 'CHoCH',
  event: StructureBreakEvent,
  bars: readonly OhlcvBar[],
): string {
  const breakDate = barDate(bars, event.index)
  const swingDate = barDate(bars, event.brokenSwing.index)
  return [
    kind,
    event.level,
    event.type,
    breakDate,
    swingDate,
    String(event.brokenSwing.price),
    String(event.price),
  ].join('|')
}

/** Stable id for an FVG/VI/OG zone. */
export function fvgZoneId(fvg: FairValueGap, bars: readonly OhlcvBar[]): string {
  return [
    'FVG',
    fvg.variant,
    fvg.type,
    barDate(bars, fvg.formationIndex),
    String(fvg.top),
    String(fvg.bottom),
  ].join('|')
}

/** Stable id for an order-block zone. */
export function orderBlockZoneId(ob: OrderBlock, bars: readonly OhlcvBar[]): string {
  return [
    'OB',
    ob.type,
    ob.level,
    barDate(bars, ob.index),
    String(ob.top),
    String(ob.bottom),
  ].join('|')
}
