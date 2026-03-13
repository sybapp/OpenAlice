import type { SessionStore } from '../session.js'
import type { EngineContext, MediaAttachment } from '../types.js'

export const LOCAL_COMMAND_METADATA = { kind: 'local_command' } as const
export const UNHANDLED_LOCAL_COMMAND_RESULT: LocalCommandResult = { handled: false, media: [] }

export interface LocalCommandContext {
  session: SessionStore
  engineContext?: EngineContext
  source?: string
  actorId?: string
  surface?: string
}

export interface LocalCommandResult {
  handled: boolean
  text?: string
  media: MediaAttachment[]
}

export function handledLocalCommand(text: string, media: MediaAttachment[] = []): LocalCommandResult {
  return { handled: true, text, media }
}

export interface LocalCommandHandler {
  matches(prompt: string): boolean
  handle(prompt: string, context: LocalCommandContext): Promise<LocalCommandResult>
}
