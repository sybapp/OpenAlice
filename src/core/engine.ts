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
import { StreamableResult, streamFromResult, type ProviderEvent } from './ai-provider.js'
import type { AgentCenter } from './agent-center.js'
import { type LocalCommandRouter } from './commands/router.js'
import {
  createDefaultEngineSessionHandlers,
  type EngineSessionHandler,
  type EngineSessionRouteOptions,
  type AgentSkillRuntime,
} from './engine-runtime.js'

// ==================== Types ====================

export interface EngineOpts {
  /** Explicit session runtime pipeline. */
  sessionHandlers?: EngineSessionHandler[]
  /** The AgentCenter that owns provider routing when using the default pipeline. */
  agentCenter?: AgentCenter
  /** Handles slash-style local commands before provider routing when using the default pipeline. */
  commandRouter?: LocalCommandRouter
  /** Handles AgentSkill execution when using the default pipeline. */
  agentSkillRuntime?: AgentSkillRuntime
}

export interface EngineResult {
  text: string
  /** Media produced by tools during the generation (e.g. screenshots). */
  media: MediaAttachment[]
}

export interface EngineAskOptions extends EngineSessionRouteOptions {}

// ==================== Engine ====================

export class Engine {
  private readonly sessionHandlers: EngineSessionHandler[]

  constructor(opts: EngineOpts) {
    if (opts.sessionHandlers) {
      this.sessionHandlers = opts.sessionHandlers
      return
    }

    if (!opts.agentCenter || !opts.commandRouter) {
      throw new Error('Engine requires either sessionHandlers or the default routing dependencies.')
    }

    this.sessionHandlers = createDefaultEngineSessionHandlers({
      agentCenter: opts.agentCenter,
      commandRouter: opts.commandRouter,
      agentSkillRuntime: opts.agentSkillRuntime ?? null,
    })
  }

  // ==================== Public API ====================

  /** Simple prompt (no session context). Routed through the configured AI provider. */
  async ask(prompt: string): Promise<EngineResult> {
    const lastHandler = this.sessionHandlers[this.sessionHandlers.length - 1]
    if (!lastHandler || lastHandler.id !== 'provider-route') {
      throw new Error('Engine.ask requires a provider-route terminal handler.')
    }
    if (!lastHandler.handleStateless) {
      throw new Error('Engine.ask requires stateless provider support.')
    }
    return lastHandler.handleStateless(prompt)
  }

  /** Prompt with session — routed through the configured AI provider. */
  askWithSession(prompt: string, session: SessionStore, opts?: EngineAskOptions): StreamableResult {
    const self = this

    async function* generate(): AsyncGenerator<ProviderEvent> {
      for (const handler of self.sessionHandlers) {
        const handled = handler.handle({ prompt, session, opts })
        const result = handled instanceof StreamableResult ? handled : await handled
        if (!result) continue
        const stream = result instanceof StreamableResult ? result : streamFromResult(result)
        yield* stream
        return
      }

      throw new Error('Engine session pipeline ended without a terminal handler.')
    }

    return new StreamableResult(generate())
  }
}
