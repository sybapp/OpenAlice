import { Hono } from 'hono'
import type { EngineContext } from '../../../core/types.js'

export function createBacktestRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/runs', async (c) => {
    try {
      return c.json({ runs: await ctx.backtest.listRuns() })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post('/runs', async (c) => {
    try {
      const body = await c.req.json<{
        runId?: string
        accountId?: string
        accountLabel?: string
        initialCash: number
        startTime?: string
        guards?: Array<{ type: string; options?: Record<string, unknown> }>
        bars: Array<{
          ts: string
          symbol: string
          open: number
          high: number
          low: number
          close: number
          volume: number
          bid?: number
          ask?: number
        }>
        strategy:
          | { mode: 'scripted'; decisions: Array<{ step: number; operations: Array<{ action: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder' | 'syncOrders'; params: Record<string, unknown> }> }> }
          | { mode: 'ai'; prompt: string; systemPrompt?: string; maxHistoryEntries?: number }
      }>()

      if (!body.initialCash || !Array.isArray(body.bars) || body.bars.length === 0 || !body.strategy) {
        return c.json({ error: 'initialCash, bars, and strategy are required' }, 400)
      }

      const result = await ctx.backtest.startRun(body)
      return c.json(result)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id', async (c) => {
    try {
      const run = await ctx.backtest.getRun(c.req.param('id'))
      if (!run) return c.json({ error: 'Run not found' }, 404)
      return c.json(run)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id/summary', async (c) => {
    try {
      const summary = await ctx.backtest.getSummary(c.req.param('id'))
      if (!summary) return c.json({ error: 'Summary not found' }, 404)
      return c.json(summary)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id/equity', async (c) => {
    try {
      const limit = Number(c.req.query('limit')) || undefined
      const points = await ctx.backtest.getEquityCurve(c.req.param('id'), { limit })
      return c.json({ points })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id/events', async (c) => {
    try {
      const afterSeq = Number(c.req.query('afterSeq')) || 0
      const limit = Number(c.req.query('limit')) || undefined
      const type = c.req.query('type') || undefined
      const entries = await ctx.backtest.getEvents(c.req.param('id'), { afterSeq, limit, type })
      return c.json({ entries })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id/git', async (c) => {
    try {
      const state = await ctx.backtest.getGitState(c.req.param('id'))
      if (!state) return c.json({ error: 'Git state not found' }, 404)
      return c.json(state)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id/session', async (c) => {
    try {
      return c.json({ entries: await ctx.backtest.getSessionEntries(c.req.param('id')) })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
