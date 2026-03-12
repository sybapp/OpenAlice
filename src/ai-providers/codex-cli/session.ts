import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { MediaAttachment } from '../../core/types.js'
import type { CodexCliConfig } from './types.js'
import type { ProviderEvent } from '../../core/ai-provider.js'
import { StreamableResult } from '../../core/ai-provider.js'
import { toTextHistory } from '../../core/session.js'
import { compactIfNeeded } from '../../core/compaction.js'
import { askCodexCli } from './provider.js'
import { createChannel } from '../../core/async-channel.js'

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

export function askCodexCliWithSession(
  prompt: string,
  session: SessionStore,
  config: CodexCliSessionConfig,
): StreamableResult {
  const channel = createChannel<ProviderEvent>()

  const resultPromise = (async (): Promise<CodexCliSessionResult> => {
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
    const fullPrompt = textHistory.length > 0
      ? [
          '<chat_history>',
          preamble,
          '',
          ...textHistory.map((entry) => `[${entry.role === 'user' ? 'User' : 'Bot'}] ${entry.text}`),
          '</chat_history>',
          '',
          prompt,
        ].join('\n')
      : prompt

    const result = await askCodexCli(fullPrompt, {
      ...config.codexCli,
      systemPrompt: config.systemPrompt,
      appendSystemPrompt: config.codexCli.appendSystemPrompt,
      onText: (text) => {
        if (text.trim()) {
          channel.push({ type: 'text', text })
        }
      },
      onCommandStart: ({ id, command }) => {
        channel.push({
          type: 'tool_use',
          id,
          name: 'Bash',
          input: { command },
        })
      },
      onCommandFinish: ({ id, output, exitCode }) => {
        const suffix = exitCode == null ? '' : `\n(exit code ${exitCode})`
        channel.push({
          type: 'tool_result',
          tool_use_id: id,
          content: `${output}${suffix}`.trim(),
        })
      },
    })

    const text = result.ok ? result.text : `[error] ${result.text}`
    await session.appendAssistant(text, 'codex-cli')

    const finalResult = { text, media: [] }
    channel.push({ type: 'done', result: finalResult })
    return finalResult
  })()

  resultPromise
    .then(() => channel.close())
    .catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))

  return new StreamableResult(channel)
}
