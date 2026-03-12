/**
 * ClaudeCodeProvider — AIProvider implementation backed by the Claude Code CLI.
 *
 * Thin adapter: delegates to askClaudeCodeWithSession which owns the full
 * session management flow (append → compact → build <chat_history> → call CLI → persist).
 *
 * Agent config (evolutionMode, allowedTools, disallowedTools) is re-read from
 * disk on every request so that Web UI changes take effect without restart.
 */

import { resolve } from 'node:path'
import { StreamableResult, type AIProvider, type AskOptions, type ProviderEvent, type ProviderResult } from '../../core/ai-provider.js'
import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { ClaudeCodeConfig } from './types.js'
import { readAgentConfig } from '../../core/config.js'
import { askClaudeCode } from './provider.js'
import { askClaudeCodeWithSession } from './session.js'
import { getSkillPack } from '../../core/skills/registry.js'
import { buildSkillPromptText, mapSkillDenyToClaudeTools } from '../../core/skills/policy.js'
import { getSessionSkillId } from '../../core/skills/session-skill.js'

export class ClaudeCodeProvider implements AIProvider {
  constructor(
    private compaction: CompactionConfig,
    private systemPrompt?: string,
  ) {}

  /** Re-read agent config from disk to pick up hot-reloaded settings. */
  private async resolveConfig(): Promise<ClaudeCodeConfig> {
    const agent = await readAgentConfig()
    return {
      ...agent.claudeCode,
      evolutionMode: agent.evolutionMode,
      cwd: agent.evolutionMode ? process.cwd() : resolve('data/brain'),
    }
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const result = await askClaudeCode(prompt, config)
    return { text: result.text, media: [] }
  }

  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult {
    const self = this

    async function* generate(): AsyncGenerator<ProviderEvent> {
      const resolvedConfig = await self.resolveConfig()
      const skillId = await getSessionSkillId(session)
      const skill = skillId ? await getSkillPack(skillId) : null
      const appendSystemPrompt = [
        opts?.appendSystemPrompt,
        buildSkillPromptText(skill),
      ].filter(Boolean).join('\n\n') || undefined
      const disallowedTools = [
        ...(resolvedConfig.disallowedTools ?? []),
        ...mapSkillDenyToClaudeTools(skill?.toolDeny),
      ]

      yield* askClaudeCodeWithSession(prompt, session, {
        claudeCode: {
          ...resolvedConfig,
          disallowedTools,
          appendSystemPrompt,
        },
        compaction: self.compaction,
        ...opts,
        systemPrompt: opts?.systemPrompt ?? self.systemPrompt,
      })
    }

    return new StreamableResult(generate())
  }
}
