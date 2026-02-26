/**
 * CodexCliProvider — AIProvider implementation backed by Codex CLI (`codex exec --json`).
 *
 * Mirrors the ClaudeCodeProvider shape so backend routing remains symmetric.
 */

import { resolve } from 'node:path'
import type { AIProvider, AskOptions, ProviderResult } from '../../core/ai-provider.js'
import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { CodexCliConfig } from './types.js'
import { readAgentConfig, readAIProviderConfig } from '../../core/config.js'
import { askCodexCli } from './provider.js'
import { askCodexCliWithSession } from './session.js'

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

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const result = await askCodexCli(prompt, config)
    return { text: result.text, media: [] }
  }

  async askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    return askCodexCliWithSession(prompt, session, {
      codexCli: config,
      compaction: this.compaction,
      ...opts,
      systemPrompt: opts?.systemPrompt ?? this.systemPrompt,
    })
  }
}
