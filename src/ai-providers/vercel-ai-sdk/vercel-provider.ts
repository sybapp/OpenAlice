/**
 * VercelAIProvider — AIProvider implementation backed by a Vercel AI SDK tool loop.
 *
 * The model is lazily created from config and cached. When ai-provider.json
 * changes on disk, the next request picks up the new model automatically.
 */

import { createHash } from 'node:crypto'
import type { ModelMessage, Tool } from 'ai'
import { StreamableResult, type AIProvider, type AskOptions, type ProviderEvent, type ProviderResult } from '../../core/ai-provider.js'
import type { Agent } from './agent.js'
import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { MediaAttachment } from '../../core/types.js'
import type { ToolPolicy } from '../../core/tool-center.js'
import { toModelMessages } from '../../core/session.js'
import { compactIfNeeded } from '../../core/compaction.js'
import { extractMediaFromToolOutput } from '../../core/media.js'
import { createModelFromConfig } from '../../core/model-factory.js'
import { createAgent } from './agent.js'
import { getSkillPack } from '../../core/skills/registry.js'
import { buildSkillPromptText, getSkillToolPolicy } from '../../core/skills/policy.js'
import { getSessionSkillId } from '../../core/skills/session-skill.js'
import { createChannel } from '../../core/async-channel.js'

export class VercelAIProvider implements AIProvider {
  private cachedAgents = new Map<string, Agent>()

  constructor(
    private getTools: (policy?: ToolPolicy) => Promise<Record<string, Tool>>,
    private instructions: string,
    private maxSteps: number,
    private compaction: CompactionConfig,
  ) {}

  private hash(value: string): string {
    return createHash('sha1').update(value).digest('hex').slice(0, 12)
  }

  private buildSkillInstructions(baseInstructions: string, skill: Awaited<ReturnType<typeof getSkillPack>>): string {
    const skillPrompt = buildSkillPromptText(skill)
    if (!skillPrompt) return baseInstructions
    return [baseInstructions, '---', skillPrompt].join('\n\n')
  }

  /** Lazily create or return the cached agent, re-creating when config or tools change. */
  private async resolveAgentForSession(session?: SessionStore): Promise<{ agent: Agent; tools: Record<string, Tool>; skillId: string | null }> {
    const { model, key: modelKey } = await createModelFromConfig()
    const skillId = session ? await getSessionSkillId(session) : null
    const skill = skillId ? await getSkillPack(skillId) : null
    const tools = await this.getTools(getSkillToolPolicy(skill))
    const finalInstructions = this.buildSkillInstructions(this.instructions, skill)
    const toolsSignature = Object.keys(tools).sort().join(',')
    const instructionsHash = this.hash(finalInstructions)
    const toolsHash = this.hash(toolsSignature)
    const cacheKey = [modelKey, skill?.id ?? 'off', instructionsHash, toolsHash, String(this.maxSteps)].join('|')
    let agent = this.cachedAgents.get(cacheKey)
    if (!agent) {
      agent = createAgent(model, tools, finalInstructions, this.maxSteps)
      this.cachedAgents.set(cacheKey, agent)
      if (this.cachedAgents.size > 16) {
        const oldestKey = this.cachedAgents.keys().next().value
        if (oldestKey) this.cachedAgents.delete(oldestKey)
      }
      console.log(`vercel-ai: model loaded → ${modelKey} (${Object.keys(tools).length} tools, skill=${skill?.id ?? 'off'})`)
    }
    return { agent, tools, skillId: skill?.id ?? null }
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const { agent } = await this.resolveAgentForSession()
    const media: MediaAttachment[] = []
    const result = await agent.generate({
      prompt,
      onStepFinish: (step) => {
        for (const tr of step.toolResults) {
          media.push(...extractMediaFromToolOutput(tr.output))
        }
      },
    })
    return { text: result.text ?? '', media }
  }

  askWithSession(prompt: string, session: SessionStore, _opts?: AskOptions): StreamableResult {
    const self = this

    async function* generate(): AsyncGenerator<ProviderEvent> {
      const { agent } = await self.resolveAgentForSession(session)

      await session.appendUser(prompt, 'human')

      const compactionResult = await compactIfNeeded(
        session,
        self.compaction,
        async (summarizePrompt) => {
          const r = await agent.generate({ prompt: summarizePrompt })
          return r.text ?? ''
        },
      )

      const entries = compactionResult.activeEntries ?? await session.readActive()
      const messages = toModelMessages(entries)
      const channel = createChannel<ProviderEvent>()
      const media: MediaAttachment[] = []

      const resultPromise = agent.generate({
        messages: messages as ModelMessage[],
        onStepFinish: (step) => {
          for (const tc of step.toolCalls) {
            channel.push({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, input: tc.input })
          }
          for (const tr of step.toolResults) {
            media.push(...extractMediaFromToolOutput(tr.output))
            channel.push({
              type: 'tool_result',
              tool_use_id: tr.toolCallId,
              content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? ''),
            })
          }
          if (step.text?.trim()) {
            channel.push({ type: 'text', text: step.text })
          }
        },
      })

      resultPromise
        .then(() => channel.close())
        .catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))

      yield* channel

      const result = await resultPromise
      const text = result.text ?? ''
      await session.appendAssistant(text, 'engine')
      yield { type: 'done', result: { text, media } }
    }

    return new StreamableResult(generate())
  }
}
