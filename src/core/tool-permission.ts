import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ToolPermissionAction = 'allow' | 'deny'
export type ToolRiskLevel = 'low' | 'medium' | 'high'

export interface ToolPermissionRule {
  action: ToolPermissionAction
  tools?: string[]
  groups?: string[]
  input?: Record<string, unknown>
  reason?: string
}

export interface ToolPermissionConfig {
  enabled: boolean
  defaultAction: ToolPermissionAction
  highRiskDefaultAction: ToolPermissionAction
  audit: boolean
  rules: ToolPermissionRule[]
}

export interface ToolPermissionRequest {
  tool: string
  group: string
  input: unknown
  sessionId?: string
  provider?: string
  channelContext?: string
}

export interface ToolPermissionDecision {
  action: ToolPermissionAction
  risk: ToolRiskLevel
  reason: string
  matchedRule?: ToolPermissionRule
}

export interface ToolPermissionAuditRecord {
  timestamp: string
  sessionId?: string
  provider?: string
  tool: string
  group: string
  action: ToolPermissionAction
  risk: ToolRiskLevel
  reason: string
  inputPreview: unknown
}

export const DEFAULT_TOOL_PERMISSION_CONFIG: ToolPermissionConfig = {
  enabled: true,
  defaultAction: 'allow',
  highRiskDefaultAction: 'deny',
  audit: true,
  rules: [],
}

const HIGH_RISK_TOOLS = new Set([
  'placeOrder',
  'modifyOrder',
  'closePosition',
  'cancelOrder',
  'tradingCommit',
  'tradingSync',
  'cronAdd',
  'cronUpdate',
  'cronRemove',
  'cronRunNow',
  'readSession',
])

const HIGH_RISK_BROWSER_ACTIONS = new Set(['act', 'upload', 'dialog', 'evaluate', 'stop'])
const SECRET_KEY_RE = /api[-_]?key|secret|password|token|authorization/i

export class ToolPermissionEngine {
  constructor(private config: ToolPermissionConfig = DEFAULT_TOOL_PERMISSION_CONFIG) {}

  decide(request: ToolPermissionRequest): ToolPermissionDecision {
    if (!this.config.enabled) {
      return { action: 'allow', risk: 'low', reason: 'tool permission engine disabled' }
    }

    const risk = classifyRisk(request)
    for (const rule of this.config.rules) {
      if (matchesRule(rule, request)) {
        return {
          action: rule.action,
          risk,
          reason: rule.reason ?? `matched ${rule.action} rule`,
          matchedRule: rule,
        }
      }
    }

    if (risk === 'high') {
      return {
        action: this.config.highRiskDefaultAction,
        risk,
        reason: `high-risk tool default ${this.config.highRiskDefaultAction}`,
      }
    }

    return {
      action: this.config.defaultAction,
      risk,
      reason: `default ${this.config.defaultAction}`,
    }
  }
}

export class ToolPermissionAuditLog {
  constructor(private logPath = 'data/logs/tool-permissions.jsonl') {}

  async append(record: ToolPermissionAuditRecord): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true })
    await appendFile(this.logPath, JSON.stringify(record) + '\n', 'utf-8')
  }
}

export function permissionDeniedResult(request: ToolPermissionRequest, decision: ToolPermissionDecision) {
  return {
    error: 'Tool call denied by permission policy',
    code: 'TOOL_PERMISSION_DENIED',
    tool: request.tool,
    reason: decision.reason,
    risk: decision.risk,
  }
}

export function makeAuditRecord(
  request: ToolPermissionRequest,
  decision: ToolPermissionDecision,
): ToolPermissionAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    sessionId: request.sessionId,
    provider: request.provider,
    tool: request.tool,
    group: request.group,
    action: decision.action,
    risk: decision.risk,
    reason: decision.reason,
    inputPreview: redactSecrets(request.input),
  }
}

export function shouldAudit(decision: ToolPermissionDecision, config: ToolPermissionConfig): boolean {
  return config.audit && (decision.action === 'deny' || decision.risk === 'high')
}

function classifyRisk(request: ToolPermissionRequest): ToolRiskLevel {
  if (HIGH_RISK_TOOLS.has(request.tool)) return 'high'
  if (request.tool === 'browser' && isRecord(request.input)) {
    if (request.input.target === 'host') return 'high'
    if (typeof request.input.action === 'string' && HIGH_RISK_BROWSER_ACTIONS.has(request.input.action)) return 'high'
  }
  if (request.group === 'trading' || request.group === 'cron' || request.group === 'session') return 'medium'
  if (request.group === 'browser') return 'medium'
  return 'low'
}

function matchesRule(rule: ToolPermissionRule, request: ToolPermissionRequest): boolean {
  const toolMatch = !rule.tools || rule.tools.some((pattern) => matchesPattern(pattern, request.tool))
  const groupMatch = !rule.groups || rule.groups.some((pattern) => matchesPattern(pattern, request.group))
  const inputMatch = !rule.input || matchesInput(rule.input, request.input)
  return toolMatch && groupMatch && inputMatch
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function matchesInput(expected: Record<string, unknown>, input: unknown): boolean {
  if (!isRecord(input)) return false
  for (const [key, value] of Object.entries(expected)) {
    if (value === '$exists') {
      if (!(key in input)) return false
    } else if (Array.isArray(value)) {
      if (!value.includes(input[key])) return false
    } else if (input[key] !== value) {
      return false
    }
  }
  return true
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
