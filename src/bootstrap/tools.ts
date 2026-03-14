/**
 * Bootstrap: Tools
 *
 * Registers all tools into the ToolCenter.
 */

import type { Config } from '../core/config.js'
import { ToolCenter } from '../core/tool-center.js'
import { createThinkingTools } from '../extension/cognition/thinking-kit/index.js'
import { createBrainTools } from '../extension/cognition/brain/index.js'
import type { AccountManager, AccountSetup } from '../extension/trading/index.js'
import { createCronTools } from '../task/cron/index.js'
import type { Brain } from '../extension/cognition/brain/index.js'
import type { initServices } from './services.js'

type Services = Awaited<ReturnType<typeof initServices>>

export async function registerAllTools(deps: {
  config: Config
  accountManager: AccountManager
  accountSetups: Map<string, AccountSetup>
  services: Services
  brain: Brain
}) {
  const { services, brain } = deps
  const { cronEngine } = services

  const toolCenter = new ToolCenter()
  toolCenter.register(createThinkingTools(), 'thinking')
  toolCenter.register(createBrainTools(brain), 'brain')
  toolCenter.register(createCronTools(cronEngine), 'cron')

  console.log(`tool-center: ${toolCenter.list().length} tools registered`)
  return toolCenter
}
