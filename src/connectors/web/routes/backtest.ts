import { Hono, type Context } from 'hono'
import { normalizeBacktestRunId, type BacktestRunConfig, type BacktestRunManager } from '../../../domains/trading/index.js'
import type { BacktestBarsQuery, MarketDataBridge } from '../../../core/types.js'
import { parseBacktestBarsQuery, parseBacktestRunConfig } from '../../../domains/trading/backtest/validation.js'
import { getValidationErrorPayload } from './zod-error.js'

interface BacktestRoutesDeps {
  backtest: Pick<
    BacktestRunManager,
    'listRuns' | 'startRun' | 'getRun' | 'getSummary' | 'getEquityCurve' | 'getEvents' | 'getGitState' | 'getSessionEntries'
  >
  marketData: Pick<MarketDataBridge, 'getBacktestBars'>
}

export function createBacktestRoutes({ backtest, marketData }: BacktestRoutesDeps) {
  const app = new Hono()

  app.get('/bars', async (c) => {
    try {
      const query = parseBarsQuery(c)
      return c.json({ bars: await marketData.getBacktestBars(query) })
    } catch (err) {
      const validationError = getValidationErrorPayload(err)
      if (validationError) {
        return c.json(validationError, 400)
      }
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, message.startsWith('Invalid ') ? 400 : 500)
    }
  })

  app.get('/runs', async (c) => {
    try {
      return c.json({ runs: await backtest.listRuns() })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post('/runs', async (c) => {
    try {
      const body = parseBacktestRunConfig(await c.req.json<BacktestRunConfig>())
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
      const validationError = getValidationErrorPayload(err)
      if (validationError) {
        return c.json(validationError, 400)
      }
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

function parseBarsQuery(c: Context): BacktestBarsQuery {
  return parseBacktestBarsQuery({
    assetType: c.req.query('assetType'),
    symbol: c.req.query('symbol')?.trim(),
    startDate: c.req.query('startDate')?.trim(),
    endDate: c.req.query('endDate')?.trim(),
    interval: c.req.query('interval')?.trim(),
  })
}

function toBacktestErrorResponse(c: Context, err: unknown) {
  const validationError = getValidationErrorPayload(err)
  if (validationError) {
    return c.json(validationError, 400)
  }
  const message = err instanceof Error ? err.message : String(err)
  const status = message.startsWith('Invalid backtest runId:')
    ? 400
    : message.startsWith('Backtest run not found:')
      ? 404
      : 500
  return c.json({ error: message }, status)
}
