import { z } from 'zod'

export const chatResponseSchema = z.object({
  text: z.string().min(1),
})

export const traderMarketScanSchema = z.object({
  candidates: z.array(z.object({
    source: z.string().min(1),
    symbol: z.string().min(1),
    reason: z.string().min(1),
  })).default([]),
  evaluations: z.array(z.object({
    source: z.string().min(1),
    symbol: z.string().min(1),
    verdict: z.enum(['candidate', 'skip']),
    reason: z.string().min(1),
  })).default([]),
  summary: z.string().default(''),
})

export const traderTradeThesisSchema = z.object({
  status: z.enum(['thesis_ready', 'no_trade']),
  source: z.string().min(1),
  symbol: z.string().min(1),
  bias: z.enum(['long', 'short', 'flat']),
  chosenScenario: z.string().min(1),
  alternateScenario: z.string().optional(),
  rationale: z.string().min(1),
  invalidation: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0),
  contextNotes: z.array(z.string()).default([]),
})

export const traderRiskCheckSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'reduce']),
  source: z.string().min(1),
  symbol: z.string().min(1),
  rationale: z.string().min(1),
  maxRiskPercent: z.number().positive().optional(),
})

export const traderPlannedOrderSchema = z.object({
  aliceId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'take_profit', 'trailing_stop', 'trailing_stop_limit', 'moc']),
  qty: z.number().positive().optional(),
  notional: z.number().positive().optional(),
  price: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  trailingAmount: z.number().positive().optional(),
  trailingPercent: z.number().positive().optional(),
  reduceOnly: z.boolean().optional(),
  timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok', 'opg', 'gtd']).default('day'),
  goodTillDate: z.string().optional(),
  extendedHours: z.boolean().optional(),
  parentId: z.string().optional(),
  ocaGroup: z.string().optional(),
  protection: z.object({
    stopLossPct: z.number().positive().optional(),
    takeProfitPct: z.number().positive().optional(),
    stopLossPrice: z.number().positive().optional(),
    takeProfitPrice: z.number().positive().optional(),
    takeProfitSizeRatio: z.number().positive().max(1).optional(),
  }).optional(),
})

export const traderTradePlanSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('plan_ready'),
    source: z.string().min(1),
    symbol: z.string().min(1),
    chosenScenario: z.string().min(1),
    rationale: z.string().min(1),
    invalidation: z.array(z.string()).default([]),
    commitMessage: z.string().min(1),
    brainUpdate: z.string().default(''),
    orders: z.array(traderPlannedOrderSchema).default([]),
  }),
  z.object({
    status: z.literal('skip'),
    source: z.string().min(1),
    symbol: z.string().min(1),
    chosenScenario: z.string().min(1),
    rationale: z.string().min(1),
    invalidation: z.array(z.string()).default([]),
    brainUpdate: z.string().default(''),
  }),
])

export const traderTradeExecuteSchema = z.object({
  status: z.enum(['execute', 'abort']),
  source: z.string().min(1),
  symbol: z.string().min(1),
  rationale: z.string().min(1),
  brainUpdate: z.string().default(''),
})

export const traderTradeReviewSchema = z.object({
  summary: z.string().min(1),
  brainUpdate: z.string().min(1),
  strategyPatch: z.object({
    behaviorRules: z.object({
      preferences: z.array(z.string()).optional(),
      prohibitions: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  patchSummary: z.string().min(1).optional(),
})

const completionSchemas = {
  ChatResponse: chatResponseSchema,
  TraderMarketScan: traderMarketScanSchema,
  TraderTradeThesis: traderTradeThesisSchema,
  TraderRiskCheck: traderRiskCheckSchema,
  TraderTradePlan: traderTradePlanSchema,
  TraderTradeExecute: traderTradeExecuteSchema,
  TraderTradeReview: traderTradeReviewSchema,
} as const

export type CompletionSchemaName = keyof typeof completionSchemas

export function getCompletionSchema(name: string) {
  return completionSchemas[name as CompletionSchemaName] ?? null
}
