import { Hono, type Context } from 'hono'
import { normalizeBacktestRunId, type BacktestRunConfig, type BacktestRunManager } from '../../../extension/trading/index.js'

interface BacktestRoutesDeps {
  backtest: Pick<
    BacktestRunManager,
    'listRuns' | 'startRun' | 'getRun' | 'getSummary' | 'getEquityCurve' | 'getEvents' | 'getGitState' | 'getSessionEntries'
  >
}

export function createBacktestRoutes({ backtest }: BacktestRoutesDeps) {
  const app = new Hono()

  app.get('/runs', async (c) => {
    try {
      return c.json({ runs: await backtest.listRuns() })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post('/runs', async (c) => {
    try {
      const body = await c.req.json<BacktestRunConfig>()

      if (!body.initialCash || !Array.isArray(body.bars) || body.bars.length === 0 || !body.strategy) {
        return c.json({ error: 'initialCash, bars, and strategy are required' }, 400)
      }
      if (body.runId != null) {
        try {
          body.runId = normalizeBacktestRunId(body.runId)
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      }

      const result = await backtest.startRun(body)
      return c.json(result)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runs/:id', async (c) => {
    try {
      const runId = parseRunId(c.req.param('id'))
      const run = await backtest.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)
      return c.json(run)
    } catch (err) {
      return toBacktestErrorResponse(c, err)
    }
  })

  app.get('/runs/:id/summary', async (c) => {
    try {
      const runId = parseRunId(c.req.param('id'))
      const summary = await backtest.getSummary(runId)
      if (!summary) return c.json({ error: 'Summary not found' }, 404)
      return c.json(summary)
    } catch (err) {
      return toBacktestErrorResponse(c, err)
    }
  })

  app.get('/runs/:id/equity', async (c) => {
    try {
      const runId = parseRunId(c.req.param('id'))
      const limit = Number(c.req.query('limit')) || undefined
      const points = await backtest.getEquityCurve(runId, { limit })
      return c.json({ points })
    } catch (err) {
      return toBacktestErrorResponse(c, err)
    }
  })

  app.get('/runs/:id/events', async (c) => {
    try {
      const runId = parseRunId(c.req.param('id'))
      const afterSeq = Number(c.req.query('afterSeq')) || 0
      const limit = Number(c.req.query('limit')) || undefined
      const type = c.req.query('type') || undefined
      const entries = await backtest.getEvents(runId, { afterSeq, limit, type })
      return c.json({ entries })
    } catch (err) {
      return toBacktestErrorResponse(c, err)
    }
  })

  app.get('/runs/:id/git', async (c) => {
    try {
      const runId = parseRunId(c.req.param('id'))
      const state = await backtest.getGitState(runId)
      if (!state) return c.json({ error: 'Git state not found' }, 404)
      return c.json(state)
    } catch (err) {
      return toBacktestErrorResponse(c, err)
    }
  })

  app.get('/runs/:id/session', async (c) => {
    try {
      const runId = parseRunId(c.req.param('id'))
      return c.json({ entries: await backtest.getSessionEntries(runId) })
    } catch (err) {
      return toBacktestErrorResponse(c, err)
    }
  })

  return app
}

function parseRunId(runId: string): string {
  return normalizeBacktestRunId(runId)
}

function toBacktestErrorResponse(c: Context, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  const status = message.startsWith('Invalid backtest runId:') ? 400 : 500
  return c.json({ error: message }, status)
}
