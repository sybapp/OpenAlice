import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { MediaAttachment } from '../../core/types.js'
import type { CodexCliConfig } from './types.js'
import { toTextHistory } from '../../core/session.js'
import { compactIfNeeded } from '../../core/compaction.js'
import { askCodexCli } from './provider.js'

export interface CodexCliSessionConfig {
  codexCli: CodexCliConfig
  compaction: CompactionConfig
  systemPrompt?: string
  maxHistoryEntries?: number
  historyPreamble?: string
}

export interface CodexCliSessionResult {
  text: string
  media: MediaAttachment[]
}

const DEFAULT_MAX_HISTORY = 50
const DEFAULT_PREAMBLE =
  'The following is the recent conversation history. Use it as context if it references earlier events or decisions.'

export async function askCodexCliWithSession(
  prompt: string,
  session: SessionStore,
  config: CodexCliSessionConfig,
): Promise<CodexCliSessionResult> {
  const maxHistory = config.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
  const preamble = config.historyPreamble ?? DEFAULT_PREAMBLE

  await session.appendUser(prompt, 'human')

  const compactionResult = await compactIfNeeded(
    session,
    config.compaction,
    async (summarizePrompt) => {
      const r = await askCodexCli(summarizePrompt, {
        ...config.codexCli,
      })
      return r.text
    },
  )

  const entries = compactionResult.activeEntries ?? await session.readActive()
  const textHistory = toTextHistory(entries).slice(-maxHistory)

  let fullPrompt: string
  if (textHistory.length > 0) {
    const lines = textHistory.map((entry) => {
      const tag = entry.role === 'user' ? 'User' : 'Bot'
      return `[${tag}] ${entry.text}`
    })
    fullPrompt = [
      '<chat_history>',
      preamble,
      '',
      ...lines,
      '</chat_history>',
      '',
      prompt,
    ].join('\n')
  } else {
    fullPrompt = prompt
  }

  const result = await askCodexCli(fullPrompt, {
    ...config.codexCli,
    systemPrompt: config.systemPrompt,
  })

  const text = result.ok ? result.text : `[error] ${result.text}`
  await session.appendAssistant(text, 'codex-cli')

  return { text, media: [] }
}
