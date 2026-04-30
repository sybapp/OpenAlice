import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EngineContext } from '../../../core/types.js'
import type { ToolApprovalStatus } from '../../../core/tool-approval-center.js'

const VALID_STATUSES = new Set<ToolApprovalStatus>(['pending', 'approved', 'rejected', 'expired', 'stale'])

export function createToolApprovalsRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/', (c) => {
    const statusRaw = c.req.query('status')
    const status = statusRaw && VALID_STATUSES.has(statusRaw as ToolApprovalStatus)
      ? statusRaw as ToolApprovalStatus
      : undefined
    const limit = Number(c.req.query('limit')) || 100
    return c.json({ approvals: ctx.toolApprovalCenter.list({ status, limit }) })
  })

  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const unsub = ctx.toolApprovalCenter.subscribe((record) => {
        stream.writeSSE({ data: JSON.stringify(record) }).catch(() => {})
      })

      const pingInterval = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }, 30_000)

      stream.onAbort(() => {
        clearInterval(pingInterval)
        unsub()
      })

      await new Promise<void>(() => {})
    })
  })

  app.get('/:id', (c) => {
    const record = ctx.toolApprovalCenter.get(c.req.param('id'))
    if (!record) return c.json({ error: 'Approval request not found' }, 404)
    return c.json(record)
  })

  app.post('/:id/approve', async (c) => {
    const record = await ctx.toolApprovalCenter.approve(c.req.param('id'), 'web')
    if (!record) return c.json({ error: 'Approval request is not pending' }, 404)
    return c.json(record)
  })

  app.post('/:id/reject', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : 'rejected by user'
    const record = await ctx.toolApprovalCenter.reject(c.req.param('id'), reason, 'web')
    if (!record) return c.json({ error: 'Approval request is not pending' }, 404)
    return c.json(record)
  })

  return app
}
