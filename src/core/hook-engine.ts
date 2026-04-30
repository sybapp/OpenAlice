import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventLog } from './event-log.js'
import type { SessionEntry } from './session.js'
import type { ToolPermissionDecision } from './tool-permission.js'

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionDenied'
  | 'PreCompact'
  | 'PostCompact'
  | 'ConfigChange'

export interface HookPayloadMap {
  SessionStart: {
    sessionId: string
    provider?: string
    profileSlug?: string
    channelContext?: string
  }
  UserPromptSubmit: {
    sessionId: string
    prompt: string
    provider?: string
    profileSlug?: string
    channelContext?: string
  }
  PreToolUse: {
    tool: string
    group: string
    input: unknown
    sessionId?: string
    provider?: string
    channelContext?: string
  }
  PostToolUse: {
    tool: string
    group: string
    input: unknown
    output: unknown
    sessionId?: string
    provider?: string
    channelContext?: string
  }
  PermissionDenied: {
    tool: string
    group: string
    input: unknown
    decision: ToolPermissionDecision
    sessionId?: string
    provider?: string
    channelContext?: string
  }
  PreCompact: {
    sessionId: string
    provider: string
    profileBackend?: string
    config: unknown
  }
  PostCompact: {
    sessionId: string
    provider: string
    compacted: boolean
    method?: string
    activeEntryCount?: number
  }
  ConfigChange: {
    section: string
    data: unknown
  }
}

export type HookMatcher =
  | string
  | RegExp
  | ((payload: HookPayloadMap[HookEventName]) => boolean)

export interface HookContext<E extends HookEventName = HookEventName> {
  event: E
  payload: HookPayloadMap[E]
  signal: AbortSignal
}

export interface HookResult {
  block?: boolean
  reason?: string
  additionalContext?: string
  updatedInput?: unknown
  updatedOutput?: unknown
  permissionDecision?: 'deny'
}

export interface HookRegistration<E extends HookEventName = HookEventName> {
  id: string
  event: E
  matcher?: HookMatcher
  priority?: number
  timeoutMs?: number
  handler: (ctx: HookContext<E>) => Promise<HookResult | void> | HookResult | void
}

export interface PromptHookConfig {
  id: string
  event: HookEventName
  enabled: boolean
  matcher?: string
  content: string
  priority: number
}

export interface HookEngineConfig {
  enabled: boolean
  audit: boolean
  timeoutMs: number
  promptHooks?: PromptHookConfig[]
}

export interface HookRunReport {
  event: HookEventName
  results: Array<{
    id: string
    durationMs: number
    blocked: boolean
    reason?: string
    errored?: boolean
    timedOut?: boolean
    additionalContext?: string
    updatedInputSet?: boolean
    updatedOutputSet?: boolean
    permissionDecision?: 'deny'
  }>
  blocked: boolean
  reason?: string
  additionalContext: string[]
  updatedInput?: unknown
  updatedInputSet: boolean
  updatedOutput?: unknown
  updatedOutputSet: boolean
  permissionDecision?: 'deny'
}

export interface HookEngineOptions {
  config?: Partial<HookEngineConfig>
  eventLog?: EventLog
  auditLogPath?: string
}

const DEFAULT_HOOK_ENGINE_CONFIG: HookEngineConfig = {
  enabled: true,
  audit: true,
  timeoutMs: 2000,
  promptHooks: [],
}

const SECRET_KEY_RE = /api[-_]?key|secret|password|token|authorization/i
const BLOCKABLE_EVENTS = new Set<HookEventName>(['UserPromptSubmit', 'PreToolUse'])

export class HookEngine {
  private config: HookEngineConfig
  private registrations = new Map<string, HookRegistration>()
  private order = new Map<string, number>()
  private promptHookIds = new Set<string>()
  private nextOrder = 0
  private auditLogPath: string
  private eventLog?: EventLog

  constructor(opts: HookEngineOptions = {}) {
    this.config = DEFAULT_HOOK_ENGINE_CONFIG
    this.auditLogPath = opts.auditLogPath ?? 'data/logs/hooks.jsonl'
    this.eventLog = opts.eventLog
    this.configure(opts.config)
  }

  configure(config?: Partial<HookEngineConfig>): void {
    for (const id of this.promptHookIds) {
      this.registrations.delete(id)
      this.order.delete(id)
    }
    this.promptHookIds.clear()
    this.config = { ...DEFAULT_HOOK_ENGINE_CONFIG, ...config }
    for (const promptHook of this.config.promptHooks ?? []) {
      const registration = promptHookToRegistration(promptHook)
      this.register(registration)
      this.promptHookIds.add(registration.id)
    }
  }

  register<E extends HookEventName>(registration: HookRegistration<E>): void {
    this.registrations.set(registration.id, registration as unknown as HookRegistration)
    if (!this.order.has(registration.id)) this.order.set(registration.id, this.nextOrder++)
  }

  unregister(id: string): void {
    this.registrations.delete(id)
    this.order.delete(id)
  }

  list(): ReadonlyArray<HookRegistration> {
    return this.sortedRegistrations()
  }

  async run<E extends HookEventName>(event: E, payload: HookPayloadMap[E]): Promise<HookRunReport> {
    const report: HookRunReport = {
      event,
      results: [],
      blocked: false,
      additionalContext: [],
      updatedInputSet: false,
      updatedOutputSet: false,
    }

    if (!this.config.enabled) return report

    for (const registration of this.sortedRegistrations()) {
      if (registration.event !== event || !matchesHook(registration.matcher, payload)) continue

      const started = Date.now()
      let result: HookResult | void = undefined
      let timedOut = false
      let errored = false
      let errorMessage: string | undefined

      try {
        result = await runWithTimeout(
          registration.handler as (ctx: HookContext<E>) => Promise<HookResult | void> | HookResult | void,
          {
            event,
            payload,
            timeoutMs: registration.timeoutMs ?? this.config.timeoutMs,
          },
        )
      } catch (err) {
        errored = true
        errorMessage = err instanceof Error ? err.message : String(err)
        timedOut = errorMessage === 'hook timeout'
      }

      const durationMs = Date.now() - started
      const blocked = Boolean(result?.block || result?.permissionDecision === 'deny') && BLOCKABLE_EVENTS.has(event)
      if (result?.additionalContext) report.additionalContext.push(result.additionalContext)
      if (result && 'updatedInput' in result) {
        report.updatedInput = result.updatedInput
        report.updatedInputSet = true
      }
      if (result && 'updatedOutput' in result) {
        report.updatedOutput = result.updatedOutput
        report.updatedOutputSet = true
      }
      if (result?.permissionDecision === 'deny') report.permissionDecision = 'deny'
      if (blocked && !report.blocked) {
        report.blocked = true
        report.reason = result?.reason ?? 'blocked by hook'
      }

      const item = {
        id: registration.id,
        durationMs,
        blocked,
        reason: result?.reason ?? errorMessage,
        errored,
        timedOut,
        additionalContext: result?.additionalContext,
        updatedInputSet: result ? 'updatedInput' in result : false,
        updatedOutputSet: result ? 'updatedOutput' in result : false,
        permissionDecision: result?.permissionDecision,
      }
      report.results.push(item)
      try {
        await this.audit(event, registration.id, payload, item)
      } catch (err) {
        console.warn('hook audit failed:', err)
      }

      if (blocked) break
    }

    return report
  }

  private sortedRegistrations(): HookRegistration[] {
    return [...this.registrations.values()].sort((a, b) => {
      const priority = (a.priority ?? 0) - (b.priority ?? 0)
      if (priority !== 0) return priority
      return (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0)
    })
  }

  private async audit(
    event: HookEventName,
    id: string,
    payload: unknown,
    item: HookRunReport['results'][number],
  ): Promise<void> {
    if (!this.config.audit) return

    const record = {
      timestamp: new Date().toISOString(),
      event,
      hookId: id,
      durationMs: item.durationMs,
      blocked: item.blocked,
      reason: item.reason,
      errored: item.errored,
      timedOut: item.timedOut,
      inputPreview: redactSecrets(payload),
    }

    await mkdir(dirname(this.auditLogPath), { recursive: true })
    await appendFile(this.auditLogPath, JSON.stringify(record) + '\n', 'utf-8')

    if (this.eventLog) {
      if (item.blocked) {
        await this.eventLog.append('hook.blocked', {
          hookId: id,
          event,
          reason: item.reason ?? 'blocked by hook',
          durationMs: item.durationMs,
        })
      } else if (item.errored) {
        await this.eventLog.append('hook.error', {
          hookId: id,
          event,
          error: item.reason ?? 'hook error',
          durationMs: item.durationMs,
        })
      } else {
        await this.eventLog.append('hook.completed', {
          hookId: id,
          event,
          durationMs: item.durationMs,
        })
      }
    }
  }
}

export function mergeHookContext(channelContext: string | undefined, additionalContext: string[]): string | undefined {
  const hookContext = additionalContext.map((item) => item.trim()).filter(Boolean)
  const parts = [
    channelContext?.trim(),
    hookContext.length ? `Hook Context:\n${hookContext.join('\n\n')}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join('\n\n') : undefined
}

export function hookDeniedResult(tool: string, reason?: string) {
  return {
    error: 'Tool call denied by hook policy',
    code: 'TOOL_HOOK_DENIED',
    tool,
    reason: reason ?? 'blocked by PreToolUse hook',
  }
}

function promptHookToRegistration(config: PromptHookConfig): HookRegistration {
  return {
    id: config.id,
    event: config.event,
    matcher: config.matcher,
    priority: config.priority,
    handler: () => config.enabled ? { additionalContext: config.content } : undefined,
  }
}

async function runWithTimeout<E extends HookEventName>(
  handler: (ctx: HookContext<E>) => Promise<HookResult | void> | HookResult | void,
  opts: { event: E; payload: HookPayloadMap[E]; timeoutMs: number },
): Promise<HookResult | void> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve(handler({ event: opts.event, payload: opts.payload, signal: controller.signal })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('hook timeout'))
        }, opts.timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function matchesHook(matcher: HookMatcher | undefined, payload: unknown): boolean {
  if (!matcher) return true
  if (typeof matcher === 'function') return matcher(payload as HookPayloadMap[HookEventName])
  const value = matcherTarget(payload)
  if (matcher instanceof RegExp) return matcher.test(value)
  if (matcher === '*') return true
  if (matcher.startsWith('/') && matcher.endsWith('/')) {
    return new RegExp(matcher.slice(1, -1)).test(value)
  }
  return matcher.split('|').map((part) => part.trim()).filter(Boolean).some((part) => matchesPattern(part, value))
}

function matcherTarget(payload: unknown): string {
  if (!isRecord(payload)) return ''
  for (const key of ['tool', 'group', 'section', 'provider', 'sessionId']) {
    const value = payload[key]
    if (typeof value === 'string') return value
  }
  return JSON.stringify(redactSecrets(payload))
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${escaped}$`).test(value)
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
