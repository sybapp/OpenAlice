/**
 * Engine — AI conversation service.
 *
 * Thin facade that delegates all calls to AgentCenter, which routes
 * through the configured AI provider (Vercel AI SDK, Claude Code, etc.)
 * via ProviderRouter.
 *
 * Both `ask()` and `askWithSession()` go through the provider route.
 *
 * Concurrency control is NOT handled here — callers (Web, Telegram, Cron, etc.)
 * manage their own serialization as appropriate for their context.
 */

import type { MediaAttachment } from './types.js'
import type { SessionStore } from './session.js'
import { StreamableResult, type AskOptions, type ProviderEvent } from './ai-provider.js'
import type { AgentCenter } from './agent-center.js'
import type { LocalCommandContext } from './commands/types.js'
import { type LocalCommandRouter } from './commands/router.js'

// ==================== Types ====================

export interface EngineOpts {
  /** The AgentCenter that owns provider routing. */
  agentCenter: AgentCenter
  /** Handles slash-style local commands before provider routing. */
  commandRouter: LocalCommandRouter
}

export interface EngineResult {
  text: string
  /** Media produced by tools during the generation (e.g. screenshots). */
  media: MediaAttachment[]
}

export interface EngineAskOptions extends AskOptions {
  commandContext?: Omit<LocalCommandContext, 'session'>
}

// ==================== Engine ====================

export class Engine {
  private agentCenter: AgentCenter
  private commandRouter: LocalCommandRouter

  constructor(opts: EngineOpts) {
    this.agentCenter = opts.agentCenter
    this.commandRouter = opts.commandRouter
  }

  // ==================== Public API ====================

  /** Simple prompt (no session context). Routed through the configured AI provider. */
  async ask(prompt: string): Promise<EngineResult> {
    return this.agentCenter.ask(prompt)
  }

  /** Prompt with session — routed through the configured AI provider. */
  askWithSession(prompt: string, session: SessionStore, opts?: EngineAskOptions): StreamableResult {
    const self = this

    async function* generate(): AsyncGenerator<ProviderEvent> {
      const { commandContext, ...providerOpts } = opts ?? {}
      const localCommand = await self.commandRouter.handle(prompt, {
        session,
        ...commandContext,
      })
      if (localCommand.handled) {
        yield {
          type: 'done',
          result: {
            text: localCommand.text ?? '',
            media: localCommand.media,
          },
        }
        return
      }

      yield* self.agentCenter.askWithSession(prompt, session, providerOpts)
    }

    return new StreamableResult(generate())
  }
}
