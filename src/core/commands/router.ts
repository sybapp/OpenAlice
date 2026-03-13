import type { SessionStore } from '../session.js'
import { compactCommandHandler } from './handlers/compact.js'
import { skillCommandHandler } from './handlers/skill.js'
import {
  LOCAL_COMMAND_METADATA,
  UNHANDLED_LOCAL_COMMAND_RESULT,
  type LocalCommandContext,
  type LocalCommandHandler,
  type LocalCommandResult,
} from './types.js'

async function appendLocalCommandExchange(session: SessionStore, prompt: string, response: string): Promise<void> {
  await session.appendUser(prompt, 'human', LOCAL_COMMAND_METADATA)
  await session.appendAssistant(response, 'engine', LOCAL_COMMAND_METADATA)
}

export class LocalCommandRouter {
  constructor(private readonly handlers: LocalCommandHandler[]) {}

  async handle(prompt: string, context: LocalCommandContext): Promise<LocalCommandResult> {
    const trimmed = prompt.trim()

    for (const handler of this.handlers) {
      if (!handler.matches(trimmed)) continue

      const result = await handler.handle(trimmed, context)
      if (!result.handled) continue

      await appendLocalCommandExchange(context.session, prompt, result.text ?? '')
      return result
    }

    return UNHANDLED_LOCAL_COMMAND_RESULT
  }
}

export function createLocalCommandRouter(): LocalCommandRouter {
  return new LocalCommandRouter([
    skillCommandHandler,
    compactCommandHandler,
  ])
}
