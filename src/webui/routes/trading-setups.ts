import { Hono } from 'hono'
import { z } from 'zod'
import type { EngineContext } from '../../core/types.js'

const numericString = z.string().min(1)
const setupStatusSchema = z.enum(['draft', 'committed', 'rejected', 'failed'])

const createTradeSetupSchema = z.object({
  alertRunId: z.string().min(1),
  source: z.string().min(1),
  aliceId: z.string().min(1),
  action: z.enum(['BUY', 'SELL']).optional(),
  orderType: z.enum(['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL', 'TRAIL LIMIT', 'MOC']).optional(),
  totalQuantity: numericString.optional(),
  cashQty: numericString.optional(),
  lmtPrice: numericString.optional(),
  auxPrice: numericString.optional(),
  trailStopPrice: numericString.optional(),
  trailingPercent: numericString.optional(),
  tif: z.enum(['DAY', 'GTC', 'IOC', 'FOK', 'OPG', 'GTD']).optional(),
  goodTillDate: z.string().optional(),
  outsideRth: z.boolean().optional(),
  takeProfitPrice: numericString.optional(),
  stopLossPrice: numericString.optional(),
  stopLossLimitPrice: numericString.optional(),
  thesis: z.string().optional(),
  invalidation: z.string().min(1),
  riskNotes: z.string().optional(),
}).refine(
  (d) => d.totalQuantity != null || d.cashQty != null,
  { message: 'Either totalQuantity or cashQty is required' },
)

export function createTradingSetupRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/setups', async (c) => {
    if (!ctx.tradeSetupStore) return c.json({ error: 'Trade setup store is not available' }, 503)
    const statusRaw = c.req.query('status')
    const status = statusRaw && setupStatusSchema.safeParse(statusRaw).success
      ? statusRaw as 'draft' | 'committed' | 'rejected' | 'failed'
      : undefined
    return c.json(await ctx.tradeSetupStore.list({
      limit: Number(c.req.query('limit')) || undefined,
      status,
      symbol: c.req.query('symbol') || undefined,
      source: c.req.query('source') || undefined,
    }))
  })

  app.post('/setups', async (c) => {
    if (!ctx.tradeSetupService) return c.json({ error: 'Trade setup service is not available' }, 503)
    try {
      const body = createTradeSetupSchema.parse(await c.req.json())
      const result = await ctx.tradeSetupService.createFromAlertRun(body)
      return c.json(result, result.ok ? 201 : 400)
    } catch (err) {
      return c.json({ error: err instanceof z.ZodError ? err.message : String(err) }, 400)
    }
  })

  app.post('/setups/:setupId/stage', async (c) => {
    if (!ctx.tradeSetupService) return c.json({ error: 'Trade setup service is not available' }, 503)
    const result = await ctx.tradeSetupService.stageSetup(c.req.param('setupId'))
    return c.json(result, result.ok ? 200 : 400)
  })

  app.post('/setups/:setupId/reject', async (c) => {
    if (!ctx.tradeSetupService) return c.json({ error: 'Trade setup service is not available' }, 503)
    const body = await c.req.json().catch(() => ({}))
    const result = await ctx.tradeSetupService.rejectSetup(
      c.req.param('setupId'),
      typeof body.reason === 'string' ? body.reason : undefined,
    )
    return c.json(result, result.ok ? 200 : 404)
  })

  return app
}
