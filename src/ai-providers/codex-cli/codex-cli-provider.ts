/**
 * CodexCliProvider — AIProvider implementation backed by Codex CLI (`codex exec --json`).
 *
 * Mirrors the ClaudeCodeProvider shape so backend routing remains symmetric.
 */

import { resolve } from 'node:path'
import { StreamableResult, type AIProvider, type AskOptions, type ProviderEvent, type ProviderResult } from '../../core/ai-provider.js'
import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { CodexCliConfig } from './types.js'
import { readAgentConfig, readAIProviderConfig } from '../../core/config.js'
import { askCodexCli } from './provider.js'
import { askCodexCliWithSession } from './session.js'
import { getSkillPack } from '../../core/skills/registry.js'
import { buildSkillPromptText } from '../../core/skills/policy.js'
import { getSessionSkillId } from '../../core/skills/session-skill.js'

export class CodexCliProvider implements AIProvider {
  constructor(
    private compaction: CompactionConfig,
    private systemPrompt?: string,
  ) {}

  private async resolveConfig(): Promise<CodexCliConfig> {
    const [agent, aiProvider] = await Promise.all([
      readAgentConfig(),
      readAIProviderConfig(),
    ])

    const codexCfg = agent.codexCli

    return {
      model: aiProvider.model,
      sandbox: codexCfg.sandbox,
      approvalPolicy: codexCfg.approvalPolicy,
      skipGitRepoCheck: codexCfg.skipGitRepoCheck,
      profile: codexCfg.profile,
      configOverrides: [...codexCfg.configOverrides],
      cwd: agent.evolutionMode ? process.cwd() : resolve('.'),
    }
  }

  private mergeSkillConfig(config: CodexCliConfig, skill: Awaited<ReturnType<typeof getSkillPack>>, appendFromOpts?: string): CodexCliConfig {
    const appendSystemPrompt = [appendFromOpts, buildSkillPromptText(skill)].filter(Boolean).join('\n\n') || undefined
    const extraOverrides = (skill?.toolDeny ?? []).map((pattern) => `tools.exclude=${JSON.stringify(pattern)}`)
    return {
      ...config,
      configOverrides: [...(config.configOverrides ?? []), ...extraOverrides],
      appendSystemPrompt,
    }
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const result = await askCodexCli(prompt, config)
    return { text: result.text, media: [] }
  }

  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult {
    const self = this

    async function* generate(): AsyncGenerator<ProviderEvent> {
      const config = await self.resolveConfig()
      const skillId = await getSessionSkillId(session)
      const skill = skillId ? await getSkillPack(skillId) : null
      const skillAwareConfig = self.mergeSkillConfig(config, skill, opts?.appendSystemPrompt)

      yield* askCodexCliWithSession(prompt, session, {
        codexCli: skillAwareConfig,
        compaction: self.compaction,
        ...opts,
        systemPrompt: opts?.systemPrompt ?? self.systemPrompt,
      })
    }

    return new StreamableResult(generate())
  }
}
