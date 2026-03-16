import { z } from 'zod'
import type { BacktestBarsQuery } from '../../../core/types.js'
import type { BacktestBar, BacktestRunConfig } from './types.js'

const datePattern = /^\d{4}-\d{2}-\d{2}$/

const finiteNumber = z.number().finite()
const nonNegativeNumber = finiteNumber.min(0)
const isoTimestamp = z.string().datetime({ offset: true })

export const backtestBarSchema = z.object({
  ts: isoTimestamp,
  symbol: z.string().trim().min(1),
  open: nonNegativeNumber,
  high: nonNegativeNumber,
  low: nonNegativeNumber,
  close: nonNegativeNumber,
  volume: nonNegativeNumber,
  bid: nonNegativeNumber.optional(),
  ask: nonNegativeNumber.optional(),
}).superRefine((bar, ctx) => {
  const ceiling = Math.max(bar.open, bar.close, bar.low)
  const floor = Math.min(bar.open, bar.close, bar.high)

  if (bar.high < ceiling) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['high'],
      message: 'high must be greater than or equal to open, close, and low',
    })
  }

  if (bar.low > floor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['low'],
      message: 'low must be less than or equal to open, close, and high',
    })
  }

  if (bar.bid != null && bar.ask != null && bar.bid > bar.ask) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bid'],
      message: 'bid must be less than or equal to ask',
    })
  }
})

const scriptedStrategySchema = z.object({
  mode: z.literal('scripted'),
  decisions: z.array(z.object({
    step: z.number().int().min(0),
    operations: z.array(z.object({
      action: z.string(),
      params: z.record(z.string(), z.unknown()),
    }).passthrough()),
  })),
})

const aiStrategySchema = z.object({
  mode: z.literal('ai'),
  prompt: z.string().trim().min(1),
  strategyId: z.string().trim().min(1).optional(),
  systemPrompt: z.string().optional(),
  maxHistoryEntries: z.number().int().positive().optional(),
})

export const backtestRunConfigSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  accountId: z.string().trim().min(1).optional(),
  accountLabel: z.string().trim().min(1).optional(),
  initialCash: nonNegativeNumber,
  startTime: isoTimestamp.optional(),
  guards: z.array(z.object({
    type: z.string(),
    options: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
  bars: z.array(backtestBarSchema).min(1),
  strategy: z.discriminatedUnion('mode', [scriptedStrategySchema, aiStrategySchema]),
}).superRefine((config, ctx) => {
  if (!config.startTime || config.bars.length === 0) return

  const startTs = Date.parse(config.startTime)
  const lastBarTs = Date.parse(config.bars.reduce((latest, bar) => {
    return Date.parse(bar.ts) > Date.parse(latest.ts) ? bar : latest
  }).ts)

  if (startTs > lastBarTs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startTime'],
      message: 'startTime must be on or before the last bar timestamp',
    })
  }
})

export const backtestBarsQuerySchema = z.object({
  assetType: z.literal('crypto'),
  symbol: z.string().trim().min(1),
  startDate: z.string().regex(datePattern, 'expected YYYY-MM-DD'),
  endDate: z.string().regex(datePattern, 'expected YYYY-MM-DD'),
  interval: z.string().trim().min(1).optional(),
}).superRefine((query, ctx) => {
  if (query.startDate > query.endDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'endDate must be on or after startDate',
    })
  }
})

export function parseBacktestBarsQuery(input: unknown): BacktestBarsQuery {
  return backtestBarsQuerySchema.parse(input)
}

export function parseBacktestRunConfig(input: unknown): BacktestRunConfig {
  return backtestRunConfigSchema.parse(input) as BacktestRunConfig
}

export function isBacktestBar(value: unknown): value is BacktestBar {
  return backtestBarSchema.safeParse(value).success
}
