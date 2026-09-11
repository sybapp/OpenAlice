// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { watchRuleSummary, watchSourceLabel, watchSummary } from './watch-summary'

describe('watch-summary', () => {
  it('labels the source with its barId and interval', () => {
    expect(watchSourceLabel({
      source: { barId: 'tradingview|NVDA', interval: '1h' },
    })).toBe('tradingview|NVDA · 1h')
  })

  it('summarizes a single leaf', () => {
    expect(watchRuleSummary({ type: 'price_above', price: 190.5 })).toBe('close > 190.5')
    expect(watchRuleSummary({ type: 'ema_alignment', direction: 'bearish' })).toBe('EMA bearish alignment')
    expect(watchRuleSummary({ type: 'price_vs_vwap', relation: 'at' })).toBe('close at VWAP')
    expect(watchRuleSummary({ type: 'zone_touch', zone: 'OB', relation: 'touch' })).toBe('OB touch')
    expect(watchRuleSummary({ type: 'structure_break', kind: 'any' })).toBe('new any break')
  })

  it('joins all/any groups with distinct separators', () => {
    expect(watchRuleSummary({
      all: [
        { type: 'price_above', price: 190.5 },
        { type: 'ema_alignment', direction: 'bullish' },
      ],
    })).toBe('close > 190.5 + EMA bullish alignment')
    expect(watchRuleSummary({
      any: [
        { type: 'price_below', price: 50 },
        { type: 'price_cross_above', price: 100 },
      ],
    })).toBe('close < 50 / cross above 100')
  })

  it('renders the full one-line summary', () => {
    expect(watchSummary({
      version: 1,
      source: { barId: 'tradingview|NVDA', interval: '1h' },
      rule: {
        all: [
          { type: 'price_above', price: 190.5 },
          { type: 'ema_alignment', direction: 'bullish' },
        ],
      },
    })).toBe('tradingview|NVDA · 1h: close > 190.5 + EMA bullish alignment')
  })
})
