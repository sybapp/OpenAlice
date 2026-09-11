/**
 * `watch` declaration round-trip specs: schema validation, frontmatter
 * parsing, and mutation — the contract half of increment 1. Unknown leaf
 * types, extra keys, and bad params are invalid files (loud), never silent
 * misses. Watch round-trips through create/update + read-back like any other
 * frontmatter field.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readWorkspaceIssues } from './declaration.js'
import { createIssue, updateIssueFields } from './mutate.js'
import { issueWatchSchema } from '../../domain/analysis/technical-analysis/watch/spec.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'issues-watch-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const baseWatch = {
  version: 1,
  source: { barId: 'tradingview|NVDA', interval: '1h' },
  rule: { type: 'price_above', price: 190.5 },
}

describe('issueWatchSchema', () => {
  it('accepts a single leaf and a one-level all/any group', () => {
    expect(issueWatchSchema.safeParse(baseWatch).success).toBe(true)
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      rule: {
        all: [
          { type: 'price_above', price: 100 },
          { type: 'ema_alignment', direction: 'bullish' },
        ],
      },
    }).success).toBe(true)
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      rule: { any: [{ type: 'price_below', price: 50 }] },
    }).success).toBe(true)
  })

  it('accepts all v1 leaf types', () => {
    const leaves = [
      { type: 'price_above', price: 1 },
      { type: 'price_below', price: 1 },
      { type: 'price_in_range', low: 1, high: 2 },
      { type: 'price_out_of_range', low: 1, high: 2 },
      { type: 'price_cross_above', price: 1 },
      { type: 'price_cross_below', price: 1 },
      { type: 'ema_alignment', direction: 'bullish' },
      { type: 'price_vs_ema', which: 'fast', relation: 'above' },
      { type: 'price_vs_vwap', relation: 'at' },
      { type: 'structure_break', kind: 'any' },
      { type: 'zone_touch', zone: 'OB', relation: 'touch' },
    ]
    for (const leaf of leaves) {
      expect(issueWatchSchema.safeParse({ ...baseWatch, rule: leaf }).success).toBe(true)
    }
  })

  it('rejects unknown leaf types, extra keys, and nested groups', () => {
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      rule: { type: 'rsi_above', rsi: 70 },
    }).success).toBe(false)
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      rule: { type: 'price_above', price: 1, timeframe: '1h' },
    }).success).toBe(false)
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      rule: { all: [{ all: [{ type: 'price_above', price: 1 }] }] },
    }).success).toBe(false)
  })

  it('rejects inverted ranges and non-closed-bar quotes', () => {
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      rule: { type: 'price_in_range', low: 5, high: 1 },
    }).success).toBe(false)
    expect(issueWatchSchema.safeParse({
      ...baseWatch,
      quote: { kind: 'realtime_touch' },
    }).success).toBe(false)
  })
})

describe('watch frontmatter round-trip', () => {
  it('creates and reads back a watch', async () => {
    const res = await createIssue(dir, {
      id: 'nvda-watch',
      title: 'NVDA breakout watch',
      when: { kind: 'every', every: '15m' },
      watch: baseWatch,
      what: 'watch NVDA',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.issue.watch).toMatchObject({
      version: 1,
      source: { barId: 'tradingview|NVDA', interval: '1h' },
    })
  })

  it('updates a watch (version bump) without disturbing the schedule', async () => {
    await createIssue(dir, {
      id: 'w',
      title: 'W',
      when: { kind: 'every', every: '15m' },
      watch: baseWatch,
    })
    const next = {
      ...baseWatch,
      version: 2,
      rule: { type: 'price_above' as const, price: 200 },
    }
    const res = await updateIssueFields(dir, 'w', { watch: next })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.issue.watch).toMatchObject({ version: 2, rule: { type: 'price_above', price: 200 } })
    expect(res.issue.when).toEqual({ kind: 'every', every: '15m' })
  })

  it('clears a watch with null', async () => {
    await createIssue(dir, { id: 'w', title: 'W', watch: baseWatch })
    const res = await updateIssueFields(dir, 'w', { watch: null })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.issue.watch).toBeUndefined()
  })

  it('marks a bad watch file invalid without poisoning the rest', async () => {
    await createIssue(dir, { id: 'good', title: 'Good', watch: baseWatch })
    const bad = await createIssue(dir, {
      id: 'bad',
      title: 'Bad',
      watch: { ...baseWatch, rule: { type: 'rsi_above', rsi: 70 } },
    })
    expect(bad.ok).toBe(false)
    const r = await readWorkspaceIssues(dir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.issues.map((i) => i.id)).toEqual(['good'])
  })

  it('returns invalid when patching a malformed watch', async () => {
    await createIssue(dir, { id: 'w', title: 'W', watch: baseWatch })
    const res = await updateIssueFields(dir, 'w', {
      watch: { ...baseWatch, rule: { type: 'price_in_range', low: 9, high: 1 } },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('invalid')
  })

  it('pauses and resumes without touching the plan or latch version', async () => {
    await createIssue(dir, { id: 'w', title: 'W', watch: baseWatch })
    const paused = await updateIssueFields(dir, 'w', { watchPaused: true })
    expect(paused.ok).toBe(true)
    if (!paused.ok) return
    expect(paused.issue.watchPaused).toBe(true)
    expect(paused.issue.watch).toMatchObject({ version: 1 })
    const resumed = await updateIssueFields(dir, 'w', { watchPaused: null })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.issue.watchPaused).toBeUndefined()
    expect(resumed.issue.watch).toMatchObject({ version: 1 })
    const resumedFalse = await updateIssueFields(dir, 'w', { watchPaused: false })
    expect(resumedFalse.ok).toBe(true)
  })
})
