import { Hono } from 'hono'
import type { Context } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import type { CronSchedule } from '../../../jobs/cron/engine.js'
import { listTraderStrategySummaries, getTraderStrategy } from '../../../jobs/strategies/index.js'

type ScheduleInput = { kind: string; at?: string; every?: string; cron?: string }
type TraderJobInput = {
  name?: string
  strategyId?: string
  schedule?: ScheduleInput
  enabled?: boolean
}

function jsonError(c: Context, err: unknown, status = 500) {
  return c.json({ error: String(err) }, status as any)
}

async function requireStrategy(c: Context, strategyId: string | undefined) {
  if (!strategyId) {
    return null
  }
  const strategy = await getTraderStrategy(strategyId)
  if (strategy) {
    return strategy
  }
  return c.json({ error: `Unknown strategy: ${strategyId}` }, { status: 404 })
}

function asSchedule(schedule?: ScheduleInput): CronSchedule | undefined {
  return schedule as CronSchedule | undefined
}

export function createStrategiesRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/strategies', async (c) => {
    try {
      return c.json({ strategies: await listTraderStrategySummaries() })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.get('/strategies/:id', async (c) => {
    try {
      const strategy = await getTraderStrategy(c.req.param('id'))
      if (!strategy) {
        return c.json({ error: `Unknown strategy: ${c.req.param('id')}` }, { status: 404 })
      }
      return c.json(strategy)
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.get('/jobs', (c) => {
    return c.json({ jobs: ctx.trader.list() })
  })

  app.post('/jobs', async (c) => {
    try {
      const body = await c.req.json<TraderJobInput>()
      if (!body.name || !body.strategyId || !body.schedule?.kind) {
        return c.json({ error: 'name, strategyId, and schedule are required' }, { status: 400 })
      }
      const strategyResult = await requireStrategy(c, body.strategyId)
      if (strategyResult instanceof Response) {
        return strategyResult
      }
      const id = await ctx.trader.add({
        name: body.name,
        strategyId: body.strategyId,
        schedule: asSchedule(body.schedule)!,
        enabled: body.enabled,
      })
      return c.json({ id })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.patch('/jobs/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json<TraderJobInput>()
      const strategyResult = await requireStrategy(c, body.strategyId)
      if (strategyResult instanceof Response) {
        return strategyResult
      }
      await ctx.trader.update(id, {
        name: body.name,
        strategyId: body.strategyId,
        schedule: asSchedule(body.schedule),
        enabled: body.enabled,
      })
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.delete('/jobs/:id', async (c) => {
    try {
      await ctx.trader.remove(c.req.param('id'))
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.post('/jobs/:id/run', async (c) => {
    try {
      await ctx.trader.runNow(c.req.param('id'))
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.post('/review', async (c) => {
    try {
      const body = await c.req.json<{ strategyId?: string }>().catch((): { strategyId?: string } => ({}))
      return c.json(await ctx.runTraderReview(body.strategyId))
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.get('/review/jobs', (c) => {
    return c.json({ jobs: ctx.traderReview.list() })
  })

  app.post('/review/jobs', async (c) => {
    try {
      const body = await c.req.json<TraderJobInput>()
      if (!body.name || !body.schedule?.kind) {
        return c.json({ error: 'name and schedule are required' }, { status: 400 })
      }
      const strategyResult = await requireStrategy(c, body.strategyId)
      if (strategyResult instanceof Response) {
        return strategyResult
      }
      const id = await ctx.traderReview.add({
        name: body.name,
        strategyId: body.strategyId,
        schedule: asSchedule(body.schedule)!,
        enabled: body.enabled,
      })
      return c.json({ id })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.patch('/review/jobs/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json<TraderJobInput>()
      const strategyResult = await requireStrategy(c, body.strategyId)
      if (strategyResult instanceof Response) {
        return strategyResult
      }
      await ctx.traderReview.update(id, {
        name: body.name,
        strategyId: body.strategyId,
        schedule: asSchedule(body.schedule),
        enabled: body.enabled,
      })
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.delete('/review/jobs/:id', async (c) => {
    try {
      await ctx.traderReview.remove(c.req.param('id'))
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  app.post('/review/jobs/:id/run', async (c) => {
    try {
      await ctx.traderReview.runNow(c.req.param('id'))
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, err)
    }
  })

  return app
}
