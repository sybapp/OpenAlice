import { buildSkillCatalog, getUserInvocableSkill } from '../../../skills/catalog.js'
import { getSessionSkillId, setSessionSkill } from '../../../skills/session-skill.js'
import { handledLocalCommand, type LocalCommandHandler } from '../types.js'

export const skillCommandHandler: LocalCommandHandler = {
  matches(prompt: string): boolean {
    return /^\/skill(?:\s|$)/.test(prompt.trim())
  },

  async handle(prompt, context) {
    const parts = prompt.trim().split(/\s+/)
    const subcommand = parts[1]

    if (!subcommand) {
      const activeId = await getSessionSkillId(context.session)
      const text = activeId
        ? `Current active skill: ${activeId}`
        : 'No active skill. Use /skill list to see available packs.'
      return handledLocalCommand(text)
    }

    if (subcommand === 'list') {
      const { userInvocableSkills: packs } = await buildSkillCatalog()
      const text = packs.length === 0
        ? 'No skill packs available.'
        : ['Available skills:', ...packs.map((pack) => `- ${pack.id}: ${pack.label}`)].join('\n')
      return handledLocalCommand(text)
    }

    if (subcommand === 'off') {
      await setSessionSkill(context.session, null)
      return handledLocalCommand('Skill mode disabled.')
    }

    const pack = await getUserInvocableSkill(subcommand)
    if (!pack) {
      return handledLocalCommand(`Unknown skill: ${subcommand}`)
    }

    await setSessionSkill(context.session, pack.id)
    return handledLocalCommand(`Active skill set to ${pack.id} (${pack.label}).`)
  },
}
