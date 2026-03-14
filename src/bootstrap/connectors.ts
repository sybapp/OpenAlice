/**
 * Bootstrap: Connectors & Plugins
 *
 * Core plugins (MCP, Web), optional plugins (Telegram, MCP-Ask),
 * and connector reconnect logic.
 */

import { loadConfig } from '../core/config.js'
import type { Config } from '../core/config.js'
import type { Plugin, EngineContext, ReconnectResult } from '../core/types.js'
import type { ToolCenter } from '../core/tool-center.js'
import { McpPlugin } from '../plugins/mcp.js'
import { TelegramPlugin } from '../connectors/telegram/index.js'
import { WebPlugin } from '../connectors/web/index.js'
import { McpAskPlugin } from '../connectors/mcp-ask/index.js'

function sameNumberArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export interface PluginsResult {
  corePlugins: Plugin[]
  optionalPlugins: Map<string, Plugin>
}

interface OptionalPluginReconcileArgs {
  optionalPlugins: Map<string, Plugin>
  ctx: EngineContext
  changes: string[]
  name: string
  wanted: boolean
  create: () => Plugin
  changed: (plugin: Plugin) => boolean
  startedMessage: string
  stoppedMessage: string
  restartedMessage: string
}

function createMcpAskPlugin(config: Config['connectors']['mcpAsk']): McpAskPlugin {
  return new McpAskPlugin({
    port: config.port!,
    authToken: config.authToken,
  })
}

function createTelegramPlugin(config: Config['connectors']['telegram']): TelegramPlugin {
  return new TelegramPlugin({
    token: config.botToken!,
    allowedChatIds: config.chatIds,
  })
}

function setOptionalPlugin(optionalPlugins: Map<string, Plugin>, name: string, plugin?: Plugin): void {
  if (!plugin) return
  optionalPlugins.set(name, plugin)
}

async function reconcileOptionalPlugin(args: OptionalPluginReconcileArgs): Promise<void> {
  const { optionalPlugins, ctx, changes, name, wanted, create, changed, startedMessage, stoppedMessage, restartedMessage } = args
  const current = optionalPlugins.get(name)

  if (current && !wanted) {
    await current.stop()
    optionalPlugins.delete(name)
    changes.push(stoppedMessage)
    return
  }

  if (!current && wanted) {
    const plugin = create()
    await plugin.start(ctx)
    optionalPlugins.set(name, plugin)
    changes.push(startedMessage)
    return
  }

  if (!current || !wanted || !changed(current)) return

  await current.stop()
  const plugin = create()
  await plugin.start(ctx)
  optionalPlugins.set(name, plugin)
  changes.push(restartedMessage)
}

export function initPlugins(config: Config, toolCenter: ToolCenter): PluginsResult {
  const corePlugins: Plugin[] = []

  if (config.connectors.mcp.port) {
    corePlugins.push(new McpPlugin(toolCenter, config.connectors.mcp.port))
  }

  if (config.connectors.web.port) {
    corePlugins.push(new WebPlugin({ port: config.connectors.web.port, authToken: config.connectors.web.authToken }))
  }

  const optionalPlugins = new Map<string, Plugin>()
  setOptionalPlugin(
    optionalPlugins,
    'mcp-ask',
    config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port
      ? createMcpAskPlugin(config.connectors.mcpAsk)
      : undefined,
  )
  setOptionalPlugin(
    optionalPlugins,
    'telegram',
    config.connectors.telegram.enabled && config.connectors.telegram.botToken
      ? createTelegramPlugin(config.connectors.telegram)
      : undefined,
  )

  return { corePlugins, optionalPlugins }
}

export function createConnectorReconnector(args: {
  corePlugins: Plugin[]
  optionalPlugins: Map<string, Plugin>
  getCtx: () => EngineContext
}): () => Promise<ReconnectResult> {
  const { corePlugins, optionalPlugins, getCtx } = args
  let reconnecting = false

  return async (): Promise<ReconnectResult> => {
    if (reconnecting) return { success: false, error: 'Reconnect already in progress' }
    reconnecting = true
    try {
      const fresh = await loadConfig()
      const ctx = getCtx()
      const changes: string[] = []

      // --- Web ---
      const webPlugin = corePlugins.find((plugin) => plugin instanceof WebPlugin)
      if (webPlugin instanceof WebPlugin) {
        const result = await webPlugin.reconfigure({
          port: fresh.connectors.web.port,
          authToken: fresh.connectors.web.authToken,
        })
        if (result === 'updated') changes.push('web updated')
        if (result === 'restarted') changes.push(`web restarted on port ${fresh.connectors.web.port}`)
      }

      // --- MCP Ask ---
      const mcpAskWanted = fresh.connectors.mcpAsk.enabled && !!fresh.connectors.mcpAsk.port
      await reconcileOptionalPlugin({
        optionalPlugins,
        ctx,
        changes,
        name: 'mcp-ask',
        wanted: mcpAskWanted,
        create: () => createMcpAskPlugin(fresh.connectors.mcpAsk),
        changed: (plugin) => {
          const currentConfig = plugin instanceof McpAskPlugin
            ? plugin.getConfig()
            : undefined
          return (
            !currentConfig ||
            currentConfig.port !== fresh.connectors.mcpAsk.port ||
            currentConfig.authToken !== fresh.connectors.mcpAsk.authToken
          )
        },
        startedMessage: 'mcp-ask started',
        stoppedMessage: 'mcp-ask stopped',
        restartedMessage: 'mcp-ask restarted',
      })

      // --- Telegram ---
      const telegramWanted = fresh.connectors.telegram.enabled && !!fresh.connectors.telegram.botToken
      await reconcileOptionalPlugin({
        optionalPlugins,
        ctx,
        changes,
        name: 'telegram',
        wanted: telegramWanted,
        create: () => createTelegramPlugin(fresh.connectors.telegram),
        changed: (plugin) => {
          const currentConfig = plugin instanceof TelegramPlugin
            ? plugin.getConfig()
            : undefined
          return (
            !currentConfig ||
            currentConfig.token !== fresh.connectors.telegram.botToken ||
            !sameNumberArray(currentConfig.allowedChatIds, fresh.connectors.telegram.chatIds)
          )
        },
        startedMessage: 'telegram started',
        stoppedMessage: 'telegram stopped',
        restartedMessage: 'telegram restarted',
      })

      if (changes.length > 0) {
        console.log(`reconnect: connectors — ${changes.join(', ')}`)
      }
      return { success: true, message: changes.length > 0 ? changes.join(', ') : 'no changes' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('reconnect: connectors failed:', msg)
      return { success: false, error: msg }
    } finally {
      reconnecting = false
    }
  }
}
