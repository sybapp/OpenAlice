import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ToolApprovalCenter } from './tool-approval-center.js'

const decision = {
  action: 'ask' as const,
  risk: 'high' as const,
  reason: 'high-risk tool default ask',
}

describe('ToolApprovalCenter', () => {
  it('approves a pending request and resolves the waiter', async () => {
    const center = new ToolApprovalCenter({ timeoutMs: 1000 })
    const wait = center.requestApproval({ tool: 'placeOrder', group: 'trading', input: {} }, decision)
    const pending = center.list({ status: 'pending' })[0]

    await center.approve(pending.requestId)
    await expect(wait).resolves.toMatchObject({
      approved: true,
      requestId: pending.requestId,
    })
    expect(center.get(pending.requestId)?.status).toBe('approved')
  })

  it('rejects a pending request and resolves without executing', async () => {
    const center = new ToolApprovalCenter({ timeoutMs: 1000 })
    const wait = center.requestApproval({ tool: 'readSession', group: 'session', input: {} }, decision)
    const pending = center.list({ status: 'pending' })[0]

    await center.reject(pending.requestId, 'no')

    await expect(wait).resolves.toEqual({
      approved: false,
      requestId: pending.requestId,
      reason: 'no',
    })
    expect(center.get(pending.requestId)?.status).toBe('rejected')
  })

  it('expires pending requests after timeout', async () => {
    vi.useFakeTimers()
    try {
      const center = new ToolApprovalCenter({ timeoutMs: 50, now: () => Date.now() })
      const wait = center.requestApproval({ tool: 'readSession', group: 'session', input: {} }, decision)
      const pending = center.list({ status: 'pending' })[0]

      await vi.advanceTimersByTimeAsync(60)

      await expect(wait).resolves.toMatchObject({
        approved: false,
        requestId: pending.requestId,
        reason: 'approval timed out',
      })
      expect(center.get(pending.requestId)?.status).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('redacts secrets in the approval log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-approvals-'))
    const logPath = join(dir, 'tool-approvals.jsonl')
    const center = new ToolApprovalCenter({ timeoutMs: 1000, logPath })

    const wait = center.requestApproval({
      tool: 'browser',
      group: 'browser',
      input: { apiKey: 'secret-value' },
    }, decision)
    const pending = center.list({ status: 'pending' })[0]
    await center.reject(pending.requestId)
    await wait

    const raw = await readFile(logPath, 'utf-8')
    expect(raw).toContain('[redacted]')
    expect(raw).not.toContain('secret-value')
  })

  it('restores unresolved pending approvals as stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-approvals-restore-'))
    const logPath = join(dir, 'tool-approvals.jsonl')
    const center = new ToolApprovalCenter({ timeoutMs: 1000, logPath })
    void center.requestApproval({ tool: 'readSession', group: 'session', input: {} }, decision)
    const pending = center.list({ status: 'pending' })[0]
    await center.markAllPendingStale()

    const restored = new ToolApprovalCenter({ timeoutMs: 1000, logPath })
    await restored.restore()

    expect(restored.get(pending.requestId)?.status).toBe('stale')
  })
})
