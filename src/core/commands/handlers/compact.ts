import { askClaudeCode } from '../../../ai-providers/claude-code/index.js'
import { forceCompact } from '../../compaction.js'
import { handledLocalCommand, type LocalCommandHandler } from '../types.js'

export const compactCommandHandler: LocalCommandHandler = {
  matches(prompt: string): boolean {
    return /^\/compact(?:\s|$)/.test(prompt.trim())
  },

  async handle(_prompt, context) {
    const engineContext = context.engineContext
    if (!engineContext) {
      return handledLocalCommand('Compact is unavailable because runtime context is missing.')
    }

    const result = await forceCompact(
      context.session,
      async (summarizePrompt) => {
        const response = await askClaudeCode(summarizePrompt, {
          disallowedTools: engineContext.config.agent.claudeCode.disallowedTools,
          evolutionMode: engineContext.config.agent.evolutionMode,
          maxTurns: 1,
        })
        return response.text
      },
    )

    if (!result) {
      return handledLocalCommand('Session is empty, nothing to compact.')
    }

    return handledLocalCommand(`Compacted. Pre-compaction: ~${result.preTokens} tokens.`)
  },
}
