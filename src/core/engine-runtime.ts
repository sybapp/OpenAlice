import type { AgentCenter } from './agent-center.js'
import type { AskOptions, StreamableResult } from './ai-provider.js'
import { streamFromResult } from './ai-provider.js'
import type { LocalCommandContext } from './commands/types.js'
import type { LocalCommandRouter } from './commands/router.js'
import type { SessionStore } from './session.js'
import type { ProviderResult } from './ai-provider.js'

export interface EngineSessionRouteOptions extends AskOptions {
  commandContext?: Omit<LocalCommandContext, 'session'>
  skillContext?: Record<string, unknown>
}

export interface EngineSessionRequest {
  prompt: string
  session: SessionStore
  opts?: EngineSessionRouteOptions
}

export interface EngineSessionHandler {
  id: string
  handle(request: EngineSessionRequest): Promise<StreamableResult | ProviderResult | null> | StreamableResult | ProviderResult | null
  handleStateless?(prompt: string): Promise<ProviderResult>
}

export interface AgentSkillRuntime {
  getActiveAgentSkill(session: SessionStore): Promise<unknown>
  run(prompt: string, session: SessionStore, opts?: EngineSessionRouteOptions): Promise<ProviderResult>
}

export function createLocalCommandEngineHandler(commandRouter: LocalCommandRouter): EngineSessionHandler {
  return {
    id: 'local-command',
    async handle({ prompt, session, opts }) {
      const { commandContext } = opts ?? {}
      const localCommand = await commandRouter.handle(prompt, {
        session,
        ...commandContext,
      })
      if (!localCommand.handled) return null
      return streamFromResult({
        text: localCommand.text ?? '',
        media: localCommand.media,
      })
    },
  }
}

export function createAgentSkillEngineHandler(agentSkillRuntime: AgentSkillRuntime): EngineSessionHandler {
  return {
    id: 'agent-skill',
    async handle({ prompt, session, opts }) {
      const activeSkill = await agentSkillRuntime.getActiveAgentSkill(session)
      if (!activeSkill) return null
      return streamFromResult(agentSkillRuntime.run(prompt, session, opts))
    },
  }
}

export function createProviderRouteEngineHandler(agentCenter: AgentCenter): EngineSessionHandler {
  return {
    id: 'provider-route',
    handle({ prompt, session, opts }) {
      const { commandContext: _commandContext, ...providerOpts } = opts ?? {}
      return agentCenter.askWithSession(prompt, session, providerOpts)
    },
    handleStateless(prompt: string) {
      return agentCenter.ask(prompt)
    },
  }
}

export function createDefaultEngineSessionHandlers(params: {
  agentCenter: AgentCenter
  commandRouter: LocalCommandRouter
agentSkillRuntime?: AgentSkillRuntime | null
}): EngineSessionHandler[] {
  const handlers: EngineSessionHandler[] = [
    createLocalCommandEngineHandler(params.commandRouter),
  ]
  if (params.agentSkillRuntime) {
    handlers.push(createAgentSkillEngineHandler(params.agentSkillRuntime))
  }
  handlers.push(createProviderRouteEngineHandler(params.agentCenter))
  return handlers
}
