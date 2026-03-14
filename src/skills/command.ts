import type { SessionStore } from '../core/session.js'
import { skillCommandHandler } from '../core/commands/handlers/skill.js'
import { LOCAL_COMMAND_METADATA } from '../core/commands/types.js'

export interface SkillCommandResult {
  handled: boolean
  text?: string
}

export async function handleSkillCommand(prompt: string, session: SessionStore): Promise<SkillCommandResult> {
  if (!skillCommandHandler.matches(prompt)) {
    return { handled: false }
  }

  const result = await skillCommandHandler.handle(prompt, { session })
  await session.appendUser(prompt, 'human', LOCAL_COMMAND_METADATA)
  await session.appendAssistant(result.text ?? '', 'engine', LOCAL_COMMAND_METADATA)
  return { handled: result.handled, text: result.text }
}
