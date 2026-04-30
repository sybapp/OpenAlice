/**
 * ToolCenter — unified tool registry.
 *
 * All tool definitions are registered here once during bootstrap.
 * Consumers (AI providers, MCP plugin, etc.) pull from ToolCenter
 * in the format they need, instead of reaching through Engine.
 */

import type { Tool } from 'ai'
import { readToolsConfig } from './config.js'
import {
  ToolPermissionAuditLog,
  ToolPermissionEngine,
  makeAuditRecord,
  permissionDeniedResult,
  shouldAudit,
  type ToolPermissionConfig,
} from './tool-permission.js'
import { HookEngine, hookDeniedResult } from './hook-engine.js'

interface ToolEntry {
  tool: Tool
  group: string
}

export interface ToolRequestContext {
  sessionId?: string
  provider?: string
  channelContext?: string
}

export class ToolCenter {
  private tools: Record<string, ToolEntry> = {}
  private auditLog = new ToolPermissionAuditLog()
  private hookEngine?: HookEngine

  constructor(opts?: { hookEngine?: HookEngine }) {
    this.hookEngine = opts?.hookEngine
  }

  /** Batch-register tool definitions under a group. Later registrations overwrite same-name tools. */
  register(tools: Record<string, Tool>, group: string): void {
    for (const [name, tool] of Object.entries(tools)) {
      this.tools[name] = { tool, group }
    }
  }

  /** Vercel AI SDK format — returns only enabled tools (reads disabled list from disk). */
  async getVercelTools(context?: ToolRequestContext): Promise<Record<string, Tool>> {
    const { disabled, permission } = await readToolsConfig()
    const result: Record<string, Tool> = {}
    const disabledSet = new Set(disabled)
    for (const [name, entry] of Object.entries(this.tools)) {
      if (!disabledSet.has(name)) result[name] = this.wrapTool(name, entry, permission, context)
    }
    return result
  }

  /** MCP format — same filtering as Vercel. Kept separate for future divergence. */
  async getMcpTools(context?: ToolRequestContext): Promise<Record<string, Tool>> {
    return this.getVercelTools(context)
  }

  /** Full tool inventory with group metadata (for frontend / API). */
  getInventory(): Array<{ name: string; group: string; description: string }> {
    return Object.entries(this.tools).map(([name, entry]) => ({
      name,
      group: entry.group,
      description: (entry.tool.description ?? '').slice(0, 200),
    }))
  }

  /** Look up a single tool by name (for detail / execute endpoints). */
  get(name: string): Tool | null {
    return this.tools[name]?.tool ?? null
  }

  /** Look up a tool's group by name. */
  getGroup(name: string): string | null {
    return this.tools[name]?.group ?? null
  }

  /** Tool name list (for logging / debugging). */
  list(): string[] {
    return Object.keys(this.tools)
  }

  private wrapTool(
    name: string,
    entry: ToolEntry,
    permission: ToolPermissionConfig,
    context?: ToolRequestContext,
  ): Tool {
    if (!entry.tool.execute) return entry.tool

    const engine = new ToolPermissionEngine(permission)
    const original = entry.tool.execute
    return {
      ...entry.tool,
      execute: async (input, options) => {
        let effectiveInput = input
        const preHook = await this.hookEngine?.run('PreToolUse', {
          tool: name,
          group: entry.group,
          input: effectiveInput,
          sessionId: context?.sessionId,
          provider: context?.provider,
          channelContext: context?.channelContext,
        })
        if (preHook?.updatedInputSet) effectiveInput = preHook.updatedInput
        if (preHook?.blocked || preHook?.permissionDecision === 'deny') {
          return hookDeniedResult(name, preHook.reason)
        }

        const request = {
          tool: name,
          group: entry.group,
          input: effectiveInput,
          sessionId: context?.sessionId,
          provider: context?.provider,
          channelContext: context?.channelContext,
        }
        const decision = engine.decide(request)
        if (shouldAudit(decision, permission)) {
          await this.auditLog.append(makeAuditRecord(request, decision))
        }
        if (decision.action === 'deny') {
          await this.hookEngine?.run('PermissionDenied', {
            tool: name,
            group: entry.group,
            input: effectiveInput,
            decision,
            sessionId: context?.sessionId,
            provider: context?.provider,
            channelContext: context?.channelContext,
          })
          return permissionDeniedResult(request, decision)
        }

        const output = await original(effectiveInput, options)
        const postHook = await this.hookEngine?.run('PostToolUse', {
          tool: name,
          group: entry.group,
          input: effectiveInput,
          output,
          sessionId: context?.sessionId,
          provider: context?.provider,
          channelContext: context?.channelContext,
        })
        if (postHook?.updatedOutputSet) return postHook.updatedOutput
        return output
      },
    } as Tool
  }
}
