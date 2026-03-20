import type { SessionStore } from '../../core/session.js'
import type { CompactionConfig } from '../../core/compaction.js'
import type { MediaAttachment } from '../../core/types.js'
import type { ClaudeCodeConfig } from './types.js'
import type { ProviderEvent } from '../../core/ai-provider.js'
import { StreamableResult } from '../../core/ai-provider.js'
import { toTextHistory } from '../../core/session.js'
import { compactIfNeeded } from '../../core/compaction.js'
import { extractMediaFromToolResultContent } from '../../core/media.js'
import { askClaudeCode } from './provider.js'
import { createChannel } from '../../core/async-channel.js'

// ==================== Types ====================

export interface ClaudeCodeSessionConfig {
  /** Config passed through to askClaudeCode (allowedTools, disallowedTools, maxTurns, etc.). */
  claudeCode: ClaudeCodeConfig
  /** Compaction config for auto-summarization. */
  compaction: CompactionConfig
  /** Optional system prompt (passed to claude CLI --system-prompt). */
  systemPrompt?: string
  /** Max text history entries to include in <chat_history>. Default: 50. */
  maxHistoryEntries?: number
  /** Preamble text inside <chat_history> block. */
  historyPreamble?: string
}

export interface ClaudeCodeSessionResult {
  text: string
  media: MediaAttachment[]
}

// ==================== Default ====================

const DEFAULT_MAX_HISTORY = 50
const DEFAULT_PREAMBLE =
  'The following is the recent conversation history. Use it as context if it references earlier events or decisions.'

// ==================== Async Mutex ====================

const sessionLocks = new WeakMap<SessionStore, Promise<void>>()

async function withSessionLock<T>(session: SessionStore, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(session) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => { release = r })
  sessionLocks.set(session, next)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (sessionLocks.get(session) === next) sessionLocks.delete(session)
  }
}

// ==================== Public ====================

/**
 * Call Claude Code CLI with full session management:
 * append user message → compact → build history prompt → call → persist messages.
 *
 * The raw `askClaudeCode` remains available for stateless one-shot calls (e.g. compaction callbacks).
 */
export function askClaudeCodeWithSession(
  prompt: string,
  session: SessionStore,
  config: ClaudeCodeSessionConfig,
): StreamableResult {
  const channel = createChannel<ProviderEvent>()

  const resultPromise = withSessionLock(session, async (): Promise<ClaudeCodeSessionResult> => {
    const maxHistory = config.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
    const preamble = config.historyPreamble ?? DEFAULT_PREAMBLE

    await session.appendUser(prompt, 'human')

    const compactionResult = await compactIfNeeded(
      session,
      config.compaction,
      async (summarizePrompt) => {
        const r = await askClaudeCode(summarizePrompt, {
          ...config.claudeCode,
          maxTurns: 1,
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

    const media: MediaAttachment[] = []
    const result = await askClaudeCode(fullPrompt, {
      ...config.claudeCode,
      systemPrompt: config.systemPrompt,
      onToolUse: ({ id, name, input }) => {
        channel.push({ type: 'tool_use', id, name, input })
      },
      onToolResult: ({ toolUseId, content }) => {
        media.push(...extractMediaFromToolResultContent(content))
        channel.push({ type: 'tool_result', tool_use_id: toolUseId, content })
      },
      onText: (text) => {
        if (text.trim()) {
          channel.push({ type: 'text', text })
        }
      },
    })

    for (const msg of result.messages) {
      if (msg.role === 'assistant') {
        await session.appendAssistant(msg.content, 'claude-code')
      } else {
        await session.appendUser(msg.content, 'claude-code')
      }
    }

    const finalResult = {
      text: result.ok ? result.text : `[error] ${result.text}`,
      media,
    }
    channel.push({ type: 'done', result: finalResult })
    return finalResult
  })

  resultPromise
    .then(() => channel.close())
    .catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))

  return new StreamableResult(channel)
}
