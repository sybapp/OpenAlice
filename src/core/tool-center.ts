/**
 * ToolCenter — unified tool registry.
 *
 * All tool definitions are registered here once during bootstrap.
 * Consumers (AI providers, MCP plugin, etc.) pull from ToolCenter
 * in the format they need, instead of reaching through Engine.
 */

import type { Tool } from 'ai'
import { readToolsConfig } from './config.js'
import { createGlobPolicyMatcher } from './tool-policy-match.js'

interface ToolEntry {
  tool: Tool
  group: string
}

export interface ToolPolicy {
  allow?: string[]
  deny?: string[]
}

export interface ToolInventoryItem {
  name: string
  group: string
  description: string
}

export class ToolCenter {
  private tools: Record<string, ToolEntry> = {}

  /** Batch-register tool definitions under a group. Later registrations overwrite same-name tools. */
  register(tools: Record<string, Tool>, group: string): void {
    for (const [name, tool] of Object.entries(tools)) {
      this.tools[name] = { tool, group }
    }
  }

  private async getEnabledEntries(): Promise<Array<[string, ToolEntry]>> {
    const { disabled } = await readToolsConfig()
    const disabledSet = new Set(disabled)
    return Object.entries(this.tools).filter(([name]) => !disabledSet.has(name))
  }

  private applyPolicy(entries: Array<[string, ToolEntry]>, policy?: ToolPolicy): Array<[string, ToolEntry]> {
    const allow = createGlobPolicyMatcher(policy?.allow)
    const deny = createGlobPolicyMatcher(policy?.deny)
    const hasAllow = Boolean(policy?.allow?.length)
    return entries.filter(([name, entry]) => {
      const ref = [name, entry.group]
      if (deny(ref)) return false
      if (!hasAllow) return true
      return allow(ref)
    })
  }

  /** Vercel AI SDK format — returns enabled tools after global + skill policy filtering. */
  async getVercelTools(policy?: ToolPolicy): Promise<Record<string, Tool>> {
    const result: Record<string, Tool> = {}
    const entries = this.applyPolicy(await this.getEnabledEntries(), policy)
    for (const [name, entry] of entries) {
      result[name] = entry.tool
    }
    return result
  }

  /** MCP format — same filtering as Vercel. Kept separate for future divergence. */
  async getMcpTools(policy?: ToolPolicy): Promise<Record<string, Tool>> {
    return this.getVercelTools(policy)
  }

  /** Full tool inventory with group metadata (for frontend / API). */
  getInventory(): ToolInventoryItem[] {
    return Object.entries(this.tools).map(([name, entry]) => ({
      name,
      group: entry.group,
      description: (entry.tool.description ?? '').slice(0, 200),
    }))
  }

  /** Skill-filtered tool inventory after policy is applied. */
  async getSkillInventory(policy?: ToolPolicy): Promise<ToolInventoryItem[]> {
    return this.applyPolicy(await this.getEnabledEntries(), policy).map(([name, entry]) => ({
      name,
      group: entry.group,
      description: (entry.tool.description ?? '').slice(0, 200),
    }))
  }

  /** Tool name list (for logging / debugging). */
  list(): string[] {
    return Object.keys(this.tools)
  }
}
