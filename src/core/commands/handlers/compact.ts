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
        const response = await engineContext.runtimeCatalog.interactive.ask(summarizePrompt)
        return response.text
      },
    )

    if (!result) {
      return handledLocalCommand('Session is empty, nothing to compact.')
    }

    return handledLocalCommand(`Compacted. Pre-compaction: ~${result.preTokens} tokens.`)
  },
}
