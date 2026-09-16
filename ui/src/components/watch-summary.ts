/**
 * Human-readable watch summaries — one shared pure function for the Issue
 * detail Watch section and the board paused badge. Raw rule JSON is a
 * machine contract, not display copy: this renders the v1 whitelist as
 * short human phrases plus the source interval, without interpreting intent
 * beyond the declared leaves.
 */

import type { IssueWatch, IssueWatchRule } from '../api/issues.js'

type WatchRule = IssueWatchRule

function fmtPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10000) / 10000)
}

function leafSummary(type: string, leaf: Record<string, unknown>): string {
  switch (type) {
    case 'price_above':
      return `close > ${fmtPrice(leaf['price'] as number)}`
    case 'price_below':
      return `close < ${fmtPrice(leaf['price'] as number)}`
    case 'price_in_range':
      return `close in [${fmtPrice(leaf['low'] as number)}, ${fmtPrice(leaf['high'] as number)}]`
    case 'price_out_of_range':
      return `close outside [${fmtPrice(leaf['low'] as number)}, ${fmtPrice(leaf['high'] as number)}]`
    case 'price_cross_above':
      return `cross above ${fmtPrice(leaf['price'] as number)}`
    case 'price_cross_below':
      return `cross below ${fmtPrice(leaf['price'] as number)}`
    case 'price_touch':
      return `touch ${fmtPrice(leaf['price'] as number)}`
    case 'ema_alignment':
      return `EMA ${leaf['direction'] === 'bullish' ? 'bullish alignment' : 'bearish alignment'}`
    case 'price_vs_ema':
      return `close ${leaf['relation']} EMA ${leaf['which']}`
    case 'price_vs_vwap':
      return `close ${leaf['relation']} VWAP${leaf['anchor'] && leaf['anchor'] !== 'auto' ? ` (${leaf['anchor']})` : ''}`
    case 'structure_break': {
      const kind = leaf['kind'] as string
      const direction = leaf['direction'] ? ` ${leaf['direction']}` : ''
      const level = leaf['level'] ? ` ${leaf['level']}` : ''
      return `new ${kind}${direction}${level} break`
    }
    case 'zone_touch':
      return `${leaf['zone']} touch`
    default:
      return type
  }
}

function ruleLeaves(rule: WatchRule): Array<Record<string, unknown>> {
  if ('all' in rule) return rule.all as Array<Record<string, unknown>>
  if ('any' in rule) return rule.any as Array<Record<string, unknown>>
  return [rule as unknown as Record<string, unknown>]
}

/** Short source label: `NVDA · 1h`. barId keeps its source prefix so two
 * venues for the same symbol stay distinguishable. */
export function watchSourceLabel(watch: Pick<IssueWatch, 'source'>): string {
  return `${watch.source.barId} · ${watch.source.interval}`
}

/** One-line human summary of the rule: leaves joined by `+` (all) or `/`
 * (any). Unknown future leaf types fall back to their type key (loud in
 * schema validation already prevents them from reaching here silently). */
export function watchRuleSummary(rule: WatchRule): string {
  const leaves = ruleLeaves(rule)
  const joiner = 'all' in rule ? ' + ' : 'any' in rule ? ' / ' : ''
  if (!joiner) return leafSummary((leaves[0] as { type: string }).type, leaves[0]!)
  return leaves.map((leaf) => leafSummary(leaf['type'] as string, leaf)).join(joiner)
}

/** Full one-line summary: `NVDA · 1h: close > 190.5 + EMA bullish alignment`. */
export function watchSummary(watch: IssueWatch): string {
  return `${watchSourceLabel(watch)}: ${watchRuleSummary(watch.rule)}`
}
