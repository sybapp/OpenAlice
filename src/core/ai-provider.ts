/**
 * AIProvider — unified abstraction over AI backends.
 *
 * Each provider (Vercel AI SDK, Claude Code CLI, …) implements this interface
 * with its own session management flow.  ProviderRouter reads the runtime
 * config and delegates to the correct implementation.
 */

import type { SessionStore } from './session.js'
import type { MediaAttachment } from './types.js'
import { readAIProviderConfig } from './config.js'

// ==================== Provider Events ====================

export type ProviderEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ProviderResult }

// ==================== Streamable Result ====================

/**
 * Promise-compatible provider result that also exposes an async event stream.
 *
 * Callers that just `await` it keep working. Callers that need real-time UI
 * updates can iterate it for ProviderEvents before awaiting the final result.
 */
export class StreamableResult implements PromiseLike<ProviderResult>, AsyncIterable<ProviderEvent> {
  private events: ProviderEvent[] = []
  private done = false
  private result: ProviderResult | null = null
  private error: Error | null = null
  private waiters: Array<() => void> = []
  private readonly promise: Promise<ProviderResult>

  constructor(source: AsyncIterable<ProviderEvent>) {
    this.promise = this.drain(source)
  }

  private async drain(source: AsyncIterable<ProviderEvent>): Promise<ProviderResult> {
    try {
      for await (const event of source) {
        this.events.push(event)
        if (event.type === 'done') this.result = event.result
        this.notify()
      }
    } catch (err) {
      this.error = err instanceof Error ? err : new Error(String(err))
      this.notify()
      throw this.error
    } finally {
      this.done = true
      this.notify()
    }

    if (!this.result) {
      throw new Error('StreamableResult ended without a done event')
    }

    return this.result
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  then<TFulfilled = ProviderResult, TRejected = never>(
    onfulfilled?: ((value: ProviderResult) => TFulfilled | PromiseLike<TFulfilled>) | null,
    onrejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<TFulfilled | TRejected> {
    return this.promise.then(onfulfilled, onrejected)
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ProviderEvent> {
    let cursor = 0
    while (true) {
      while (cursor < this.events.length) {
        yield this.events[cursor++]
      }
      if (this.error) throw this.error
      if (this.done) return
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }
}

export function streamFromResult(result: ProviderResult | Promise<ProviderResult>): StreamableResult {
  async function* generate(): AsyncGenerator<ProviderEvent> {
    yield { type: 'done', result: await result }
  }

  return new StreamableResult(generate())
}

// ==================== Types ====================

export interface AskOptions {
  /** Preamble text inside <chat_history> block (Claude Code only). */
  historyPreamble?: string
  /** System prompt override (Claude Code only). */
  systemPrompt?: string
  /** Extra appended system prompt content (Claude Code only). */
  appendSystemPrompt?: string
  /** Max text history entries in <chat_history>. Default: 50 (Claude Code only). */
  maxHistoryEntries?: number
}

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
}

/** Unified AI provider — each backend implements its own session handling. */
export interface AIProvider {
  /** Stateless prompt — no session context. */
  ask(prompt: string): Promise<ProviderResult>
  /** Prompt with session history and compaction. */
  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult
}

// ==================== Router ====================

/** Reads runtime AI config and delegates to the correct provider. */
export class ProviderRouter implements AIProvider {
  constructor(
    private vercel: AIProvider,
    private claudeCode: AIProvider | null,
    private codexCli: AIProvider | null,
  ) {}

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await readAIProviderConfig()
    if (config.backend === 'claude-code' && this.claudeCode) {
      return this.claudeCode.ask(prompt)
    }
    if (config.backend === 'codex-cli' && this.codexCli) {
      return this.codexCli.ask(prompt)
    }
    return this.vercel.ask(prompt)
  }

  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): StreamableResult {
    const self = this

    async function* resolve(): AsyncGenerator<ProviderEvent> {
      const config = await readAIProviderConfig()
      if (config.backend === 'claude-code' && self.claudeCode) {
        yield* self.claudeCode.askWithSession(prompt, session, opts)
        return
      }
      if (config.backend === 'codex-cli' && self.codexCli) {
        yield* self.codexCli.askWithSession(prompt, session, opts)
        return
      }
      yield* self.vercel.askWithSession(prompt, session, opts)
    }

    return new StreamableResult(resolve())
  }
}
