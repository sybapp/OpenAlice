import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventLog } from './event-log.js'
import type { ConnectorCenter } from './connector-center.js'
import type {
  ToolPermissionDecision,
  ToolPermissionRequest,
} from './tool-permission.js'

export type ToolApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'stale'

export interface ToolApprovalRecord {
  requestId: string
  status: ToolApprovalStatus
  tool: string
  group: string
  risk: string
  reason: string
  sessionId?: string
  provider?: string
  channelContext?: string
  createdAt: string
  expiresAt: string
  resolvedAt?: string
  resolvedBy?: string
  inputPreview: unknown
}

export interface ToolApprovalCenterOptions {
  eventLog?: EventLog
  connectorCenter?: ConnectorCenter
  timeoutMs?: number
  logPath?: string
  now?: () => number
}

export interface ToolApprovalWaitResult {
  approved: boolean
  requestId: string
  reason: string
}

interface PendingApproval {
  record: ToolApprovalRecord
  timer: NodeJS.Timeout
  resolve: (result: ToolApprovalWaitResult) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const RECENT_LIMIT = 200
const SECRET_KEY_RE = /api[-_]?key|secret|password|token|authorization/i

export class ToolApprovalCenter {
  private pending = new Map<string, PendingApproval>()
  private recentRecords: ToolApprovalRecord[] = []
  private eventSubscribers = new Set<(record: ToolApprovalRecord) => void>()
  private timeoutMs: number
  private logPath: string
  private now: () => number

  constructor(private opts: ToolApprovalCenterOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.logPath = opts.logPath ?? 'data/logs/tool-approvals.jsonl'
    this.now = opts.now ?? Date.now
  }

  setConnectorCenter(connectorCenter: ConnectorCenter): void {
    this.opts.connectorCenter = connectorCenter
  }

  async restore(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.logPath, 'utf-8')
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }

    const byId = new Map<string, ToolApprovalRecord>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as ToolApprovalRecord
        byId.set(record.requestId, record)
      } catch { /* skip malformed lines */ }
    }

    const stale: ToolApprovalRecord[] = []
    for (const record of byId.values()) {
      if (record.status === 'pending') {
        record.status = 'stale'
        record.reason = 'approval center restarted before resolution'
        record.resolvedAt = new Date(this.now()).toISOString()
        record.resolvedBy = 'system'
        stale.push(record)
      }
      this.pushRecent(record)
    }

    for (const record of stale) {
      await this.appendLog(record)
      this.publish(record)
    }
  }

  async requestApproval(
    request: ToolPermissionRequest,
    decision: ToolPermissionDecision,
  ): Promise<ToolApprovalWaitResult> {
    const requestId = randomUUID()
    const createdAtMs = this.now()
    const record: ToolApprovalRecord = {
      requestId,
      status: 'pending',
      tool: request.tool,
      group: request.group,
      risk: decision.risk,
      reason: decision.reason,
      sessionId: request.sessionId,
      provider: request.provider,
      channelContext: request.channelContext,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.timeoutMs).toISOString(),
      inputPreview: redactSecrets(request.input),
    }

    const wait = new Promise<ToolApprovalWaitResult>((resolve) => {
      const timer = setTimeout(() => {
        this.expire(requestId).catch((err) => {
          console.warn('tool approval expiry failed:', err)
        })
      }, this.timeoutMs)
      this.pending.set(requestId, { record, timer, resolve })
    })

    this.pushRecent(record)
    this.publish(record)
    this.appendLog(record).catch((err) => {
      console.warn('tool approval log failed:', err)
    })
    this.opts.eventLog?.append('tool_approval.requested', {
      requestId,
      tool: request.tool,
      group: request.group,
      risk: decision.risk,
      sessionId: request.sessionId,
      provider: request.provider,
      expiresAt: record.expiresAt,
    }).catch((err) => {
      console.warn('tool approval event failed:', err)
    })
    this.notifyUser(record).catch((err) => {
      console.warn('tool approval notification failed:', err)
    })

    return wait
  }

  async approve(requestId: string, resolvedBy = 'web'): Promise<ToolApprovalRecord | null> {
    return this.resolvePending(requestId, 'approved', 'approved by user', resolvedBy)
  }

  async reject(requestId: string, reason = 'rejected by user', resolvedBy = 'web'): Promise<ToolApprovalRecord | null> {
    return this.resolvePending(requestId, 'rejected', reason, resolvedBy)
  }

  async expire(requestId: string): Promise<ToolApprovalRecord | null> {
    return this.resolvePending(requestId, 'expired', 'approval timed out', 'system')
  }

  list(opts?: { status?: ToolApprovalStatus; limit?: number }): ToolApprovalRecord[] {
    const limit = opts?.limit ?? 100
    const records = opts?.status
      ? this.recentRecords.filter((record) => record.status === opts.status)
      : this.recentRecords
    return records.slice(-limit).reverse()
  }

  get(requestId: string): ToolApprovalRecord | null {
    return this.pending.get(requestId)?.record
      ?? this.recentRecords.find((record) => record.requestId === requestId)
      ?? null
  }

  subscribe(listener: (record: ToolApprovalRecord) => void): () => void {
    this.eventSubscribers.add(listener)
    return () => { this.eventSubscribers.delete(listener) }
  }

  async markAllPendingStale(): Promise<void> {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.pending.get(requestId)
      if (!pending) continue
      clearTimeout(pending.timer)
      pending.record.status = 'stale'
      pending.record.resolvedAt = new Date(this.now()).toISOString()
      pending.record.reason = 'approval center stopped before resolution'
      pending.resolve({
        approved: false,
        requestId,
        reason: pending.record.reason,
      })
      this.pending.delete(requestId)
      this.pushRecent(pending.record)
      await this.appendLog(pending.record)
      this.publish(pending.record)
    }
  }

  private async resolvePending(
    requestId: string,
    status: Exclude<ToolApprovalStatus, 'pending' | 'stale'>,
    reason: string,
    resolvedBy: string,
  ): Promise<ToolApprovalRecord | null> {
    const pending = this.pending.get(requestId)
    if (!pending) return null

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    const record = pending.record
    record.status = status
    record.reason = reason
    record.resolvedAt = new Date(this.now()).toISOString()
    record.resolvedBy = resolvedBy

    await this.record(record)
    const eventType = status === 'approved'
      ? 'tool_approval.approved'
      : status === 'expired'
        ? 'tool_approval.expired'
        : 'tool_approval.rejected'
    await this.opts.eventLog?.append(eventType, {
      requestId,
      tool: record.tool,
      group: record.group,
      reason,
    })

    pending.resolve({
      approved: status === 'approved',
      requestId,
      reason,
    })
    return record
  }

  private async record(record: ToolApprovalRecord): Promise<void> {
    this.pushRecent(record)
    await this.appendLog(record)
    this.publish(record)
  }

  private async appendLog(record: ToolApprovalRecord): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true })
    await appendFile(this.logPath, JSON.stringify(record) + '\n', 'utf-8')
  }

  private pushRecent(record: ToolApprovalRecord): void {
    const existing = this.recentRecords.findIndex((item) => item.requestId === record.requestId)
    if (existing >= 0) {
      const existingRecord = this.recentRecords[existing]
      if (existingRecord.status !== 'pending' && record.status === 'pending') return
      this.recentRecords.splice(existing, 1)
    }
    this.recentRecords.push({ ...record })
    if (this.recentRecords.length > RECENT_LIMIT) {
      this.recentRecords = this.recentRecords.slice(-RECENT_LIMIT)
    }
  }

  private publish(record: ToolApprovalRecord): void {
    for (const listener of this.eventSubscribers) {
      try { listener({ ...record }) } catch { /* subscriber isolation */ }
    }
  }

  private async notifyUser(record: ToolApprovalRecord): Promise<void> {
    if (!this.opts.connectorCenter) return
    const expires = new Date(record.expiresAt).toLocaleString()
    await this.opts.connectorCenter.notify(
      [
        `Tool approval required: ${record.tool}`,
        `Risk: ${record.risk}`,
        record.sessionId ? `Session: ${record.sessionId}` : '',
        `Expires: ${expires}`,
        `Approve or reject via Web API: /api/tool-approvals/${record.requestId}`,
        'TODO: direct Telegram/MCP-Ask approval commands.',
      ].filter(Boolean).join('\n'),
      { source: 'manual', kind: 'notification' },
    )
  }
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[redacted-depth]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactSecrets(item, depth + 1))
  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactSecrets(nested, depth + 1)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
