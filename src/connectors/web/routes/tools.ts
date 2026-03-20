import { Hono } from 'hono'
import type { ToolCenter } from '../../../core/tool-center.js'
import { readToolsConfig, writeConfigSection } from '../../../core/config.js'
import { buildCapabilityInventory } from '../../../core/capabilities.js'
import { getValidationErrorPayload } from './zod-error.js'

/** Capability routes: GET / (system tools + skills + scripts + MCP surface), PUT / (update disabled system tools) */
export function createToolsRoutes(toolCenter: ToolCenter) {
  const app = new Hono()

  async function readDisabledSystemTools(bodyDisabled: unknown) {
    const inventory = await buildCapabilityInventory(toolCenter)
    const allowedNames = new Set(inventory.systemTools.map((tool) => tool.name))
    return Array.isArray(bodyDisabled)
      ? bodyDisabled.filter((name): name is string => typeof name === 'string' && allowedNames.has(name))
      : []
  }

  app.get('/', async (c) => {
    try {
      const inventory = await buildCapabilityInventory(toolCenter)
      const { disabled } = await readToolsConfig()
      return c.json({
        ...inventory,
        disabledSystemTools: disabled,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/', async (c) => {
    try {
      const body = await c.req.json()
      const nextDisabled = await readDisabledSystemTools(body.disabled)
      const validated = await writeConfigSection('tools', { disabled: nextDisabled }) as { disabled: string[] }
      return c.json({ disabledSystemTools: validated.disabled })
    } catch (err) {
      const validationError = getValidationErrorPayload(err)
      if (validationError) {
        return c.json(validationError, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
