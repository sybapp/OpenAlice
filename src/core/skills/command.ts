import type { SessionStore } from '../session.js'
import { getSkillPack, listSkillPacks } from './registry.js'
import { getSessionSkillId, setSessionSkill } from './session-skill.js'

export interface SkillCommandResult {
  handled: boolean
  text?: string
}

const LOCAL_COMMAND_METADATA = { kind: 'local_command' } as const

function isSkillCommand(prompt: string): boolean {
  return /^\/skill(?:\s|$)/.test(prompt.trim())
}

async function appendLocalCommandExchange(session: SessionStore, prompt: string, response: string): Promise<void> {
  await session.appendUser(prompt, 'human', LOCAL_COMMAND_METADATA)
  await session.appendAssistant(response, 'engine', LOCAL_COMMAND_METADATA)
}

export async function handleSkillCommand(prompt: string, session: SessionStore): Promise<SkillCommandResult> {
  const trimmed = prompt.trim()
  if (!isSkillCommand(trimmed)) {
    return { handled: false }
  }

  const parts = trimmed.split(/\s+/)
  const subcommand = parts[1]

  if (!subcommand) {
    const activeId = await getSessionSkillId(session)
    const activeText = activeId ? `Current active skill: ${activeId}` : 'No active skill. Use /skill list to see available packs.'
    await appendLocalCommandExchange(session, prompt, activeText)
    return { handled: true, text: activeText }
  }

  if (subcommand === 'list') {
    const packs = await listSkillPacks()
    const text = packs.length === 0
      ? 'No skill packs available.'
      : ['Available skills:', ...packs.map((pack) => `- ${pack.id}: ${pack.label}`)].join('\n')
    await appendLocalCommandExchange(session, prompt, text)
    return { handled: true, text }
  }

  if (subcommand === 'off') {
    await setSessionSkill(session, null)
    const text = 'Skill mode disabled.'
    await appendLocalCommandExchange(session, prompt, text)
    return { handled: true, text }
  }

  const pack = await getSkillPack(subcommand)
  if (!pack) {
    const text = `Unknown skill: ${subcommand}`
    await appendLocalCommandExchange(session, prompt, text)
    return { handled: true, text }
  }

  await setSessionSkill(session, pack.id)
  const text = `Active skill set to ${pack.id} (${pack.label}).`
  await appendLocalCommandExchange(session, prompt, text)
  return { handled: true, text }
}
