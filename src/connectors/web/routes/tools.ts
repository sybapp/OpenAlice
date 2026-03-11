import { Hono } from 'hono'
import type { ToolCenter } from '../../../core/tool-center.js'
import { readToolsConfig, writeConfigSection } from '../../../core/config.js'
import { listSkillPacks } from '../../../core/skills/registry.js'
import { getSkillToolPolicy } from '../../../core/skills/policy.js'

/** Tools routes: GET / (inventory + disabled), PUT / (update disabled list) */
export function createToolsRoutes(toolCenter: ToolCenter) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const skillId = c.req.query('skill')
      const skills = await listSkillPacks()
      const skill = skillId ? skills.find(({ id }) => id === skillId) ?? null : null
      if (skillId && !skill) {
        return c.json({ error: `Unknown skill: ${skillId}` }, 404)
      }
      const inventory = skill
        ? await toolCenter.getSkillInventory(getSkillToolPolicy(skill))
        : toolCenter.getInventory()
      const { disabled } = await readToolsConfig()
      return c.json({ inventory, disabled, skill: skill?.id ?? null, skills: skills.map(({ id, label, description }) => ({ id, label, description })) })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = await writeConfigSection('tools', body)
      return c.json(validated)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
