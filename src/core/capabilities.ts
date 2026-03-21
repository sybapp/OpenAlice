import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { EngineContext } from './types.js'
import type { ToolCenter, ToolInventoryItem } from './tool-center.js'
import { listSkillPacks, type SkillRuntime } from '../skills/registry.js'
import { listSkillScripts } from '../skills/script-registry.js'
import { setSessionSkill } from '../skills/session-skill.js'
import type { SessionEntry } from './session.js'

export interface CapabilityInventoryItem {
  id: string
  description: string
}

export interface SkillCapabilityInventoryItem extends CapabilityInventoryItem {
  label: string
  runtime: SkillRuntime
  userInvocable: boolean
  stage?: string
  resources: string[]
  allowedScripts: string[]
}

export interface ScriptCapabilityInventoryItem extends CapabilityInventoryItem {
  usedBy: string[]
}

export interface McpCapabilityInventoryItem extends CapabilityInventoryItem {
  kind: 'system-tool' | 'skill'
}

export interface CapabilityInventory {
  systemTools: ToolInventoryItem[]
  skills: SkillCapabilityInventoryItem[]
  scripts: ScriptCapabilityInventoryItem[]
  mcpExposed: McpCapabilityInventoryItem[]
}

class MemorySessionStore {
  private lastUuid: string | null = null
  private entries: SessionEntry[] = []

  constructor(readonly id: string) {}

  private appendEntry(
    type: SessionEntry['type'],
    content: SessionEntry['message']['content'],
    provider: SessionEntry['provider'],
    metadata?: Record<string, unknown>,
  ) {
    const role: SessionEntry['message']['role'] = type === 'user'
      ? 'user'
      : type === 'assistant'
        ? 'assistant'
        : 'system'
    const entry: SessionEntry = {
      type,
      message: { role, content },
      uuid: crypto.randomUUID(),
      parentUuid: this.lastUuid,
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      provider,
      ...(metadata ? { metadata } : {}),
    }
    this.entries.push(entry)
    this.lastUuid = entry.uuid
    return entry
  }

  async appendUser(content: SessionEntry['message']['content'], provider: SessionEntry['provider'] = 'human', metadata?: Record<string, unknown>) {
    return this.appendEntry('user', content, provider, metadata)
  }

  async appendAssistant(content: SessionEntry['message']['content'], provider: SessionEntry['provider'] = 'engine', metadata?: Record<string, unknown>) {
    return this.appendEntry('assistant', content, provider, metadata)
  }

  async appendSystem(content: SessionEntry['message']['content'], provider: SessionEntry['provider'] = 'engine', metadata?: Record<string, unknown>) {
    return this.appendEntry('system', content, provider, metadata)
  }

  async appendRaw(entry: SessionEntry) {
    this.entries.push(entry)
    this.lastUuid = entry.uuid
  }

  async readAll() {
    return [...this.entries]
  }

  async readActive() {
    return [...this.entries]
  }

  async restore() {}

  async exists() {
    return this.entries.length > 0
  }
}

export function getMcpSkillToolName(skillId: string): string {
  return `skill__${skillId}`
}

function isInvocableAgentSkill(skill: { runtime: SkillRuntime; userInvocable: boolean }): boolean {
  return skill.runtime === 'agent-skill' && skill.userInvocable
}

function buildScriptUsageMap(skills: Awaited<ReturnType<typeof listSkillPacks>>) {
  const scriptToSkills = new Map<string, string[]>()

  for (const skill of skills) {
    for (const scriptId of skill.allowedScripts) {
      const usedBy = scriptToSkills.get(scriptId) ?? []
      usedBy.push(skill.id)
      scriptToSkills.set(scriptId, usedBy)
    }
  }

  return scriptToSkills
}

export async function buildCapabilityInventory(toolCenter: ToolCenter): Promise<CapabilityInventory> {
  const systemTools = toolCenter.getInventory()
  const skills = await listSkillPacks()
  const scripts = listSkillScripts()
  const scriptToSkills = buildScriptUsageMap(skills)

  const skillItems: SkillCapabilityInventoryItem[] = skills.map((skill) => ({
    id: skill.id,
    label: skill.label,
    description: skill.description,
    runtime: skill.runtime,
    userInvocable: skill.userInvocable,
    ...(skill.stage ? { stage: skill.stage } : {}),
    resources: skill.resources.map((resource) => resource.id),
    allowedScripts: [...skill.allowedScripts],
  }))

  const scriptItems: ScriptCapabilityInventoryItem[] = scripts.map((script) => ({
    id: script.id,
    description: script.description,
    usedBy: scriptToSkills.get(script.id) ?? [],
  }))

  const mcpExposed: McpCapabilityInventoryItem[] = [
    ...systemTools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      kind: 'system-tool' as const,
    })),
    ...skillItems
      .filter(isInvocableAgentSkill)
      .map((skill) => ({
        id: getMcpSkillToolName(skill.id),
        description: skill.description,
        kind: 'skill' as const,
      })),
  ]

  return {
    systemTools,
    skills: skillItems,
    scripts: scriptItems,
    mcpExposed,
  }
}

export async function createMcpCapabilityTools(ctx: EngineContext): Promise<Record<string, Tool>> {
  const skills = await listSkillPacks()
  const result: Record<string, Tool> = {}

  for (const skill of skills) {
    if (!isInvocableAgentSkill(skill)) continue

    result[getMcpSkillToolName(skill.id)] = tool({
      description: skill.description,
      inputSchema: z.object({
        task: z.string().min(1).describe('The task or question for this skill capability.'),
        invocation: z.record(z.string(), z.unknown()).optional().describe('Optional structured invocation context.'),
      }),
      execute: async ({ task, invocation }) => {
        const session = new MemorySessionStore(`mcp/${skill.id}/${crypto.randomUUID().slice(0, 8)}`)
        await setSessionSkill(session as never, skill.id)
        const stream = ctx.runtimeCatalog.trader.askWithSession(task, session as never, {
          skillContext: invocation ?? {},
        })
        const result = await stream
        return {
          skillId: skill.id,
          text: result.text,
          media: result.media,
        }
      },
    })
  }

  return result
}
