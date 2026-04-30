import { describe, expect, it } from 'vitest'
import { ToolApprovalCenter } from '../../../core/tool-approval-center.js'
import type { EngineContext } from '../../../core/types.js'
import { createToolApprovalsRoutes } from './tool-approvals.js'

const decision = {
  action: 'ask' as const,
  risk: 'high' as const,
  reason: 'high-risk tool default ask',
}

function makeApp(center: ToolApprovalCenter) {
  return createToolApprovalsRoutes({ toolApprovalCenter: center } as EngineContext)
}

describe('tool approval routes', () => {
  it('lists and reads pending approvals', async () => {
    const center = new ToolApprovalCenter({ timeoutMs: 1000 })
    const app = makeApp(center)
    void center.requestApproval({ tool: 'placeOrder', group: 'trading', input: {} }, decision)

    const listRes = await app.request('/')
    const listBody = await listRes.json() as { approvals: Array<{ requestId: string; status: string }> }

    expect(listBody.approvals).toHaveLength(1)
    expect(listBody.approvals[0].status).toBe('pending')

    const getRes = await app.request(`/${listBody.approvals[0].requestId}`)
    expect(getRes.status).toBe(200)
  })

  it('approves and rejects pending approvals', async () => {
    const center = new ToolApprovalCenter({ timeoutMs: 1000 })
    const app = makeApp(center)
    const wait = center.requestApproval({ tool: 'readSession', group: 'session', input: {} }, decision)
    const id = center.list({ status: 'pending' })[0].requestId

    const approveRes = await app.request(`/${id}/approve`, { method: 'POST' })

    expect(approveRes.status).toBe(200)
    await expect(wait).resolves.toMatchObject({ approved: true, requestId: id })

    const wait2 = center.requestApproval({ tool: 'readSession', group: 'session', input: {} }, decision)
    const id2 = center.list({ status: 'pending' })[0].requestId
    const rejectRes = await app.request(`/${id2}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'no' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(rejectRes.status).toBe(200)
    await expect(wait2).resolves.toMatchObject({ approved: false, reason: 'no' })
  })
})
