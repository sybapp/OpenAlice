/**
 * Bootstrap: Connectors
 *
 * Core connectors (MCP, Web), optional connectors (Telegram, MCP-Ask),
 * and connector reconnect logic.
 */

import { loadConfig } from '../core/config.js'
import type { Config } from '../core/config.js'
import type { Plugin, EngineContext, ReconnectResult } from '../core/types.js'
import type { ToolCenter } from '../core/tool-center.js'
import { McpServerConnector } from '../connectors/mcp-server/index.js'
import { TelegramConnector } from '../connectors/telegram/index.js'
import { WebConnector } from '../connectors/web/index.js'
import { McpAskConnector } from '../connectors/mcp-ask/index.js'

function sameNumberArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export interface ConnectorsResult {
  coreConnectors: Plugin[]
  optionalConnectors: Map<string, Plugin>
}

interface OptionalConnectorReconcileArgs {
  optionalConnectors: Map<string, Plugin>
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

function createMcpAskConnector(config: Config['connectors']['mcpAsk']): McpAskConnector {
  return new McpAskConnector({
    port: config.port!,
    authToken: config.authToken,
  })
}

function createTelegramConnector(config: Config['connectors']['telegram']): TelegramConnector {
  return new TelegramConnector({
    token: config.botToken!,
    allowedChatIds: config.chatIds,
  })
}

function setOptionalConnector(optionalConnectors: Map<string, Plugin>, name: string, plugin?: Plugin): void {
  if (!plugin) return
  optionalConnectors.set(name, plugin)
}

async function reconcileOptionalConnector(args: OptionalConnectorReconcileArgs): Promise<void> {
  const { optionalConnectors, ctx, changes, name, wanted, create, changed, startedMessage, stoppedMessage, restartedMessage } = args
  const current = optionalConnectors.get(name)

  if (current && !wanted) {
    await current.stop()
    optionalConnectors.delete(name)
    changes.push(stoppedMessage)
    return
  }

  if (!current && wanted) {
    const plugin = create()
    await plugin.start(ctx)
    optionalConnectors.set(name, plugin)
    changes.push(startedMessage)
    return
  }

  if (!current || !wanted || !changed(current)) return

  await current.stop()
  const plugin = create()
  await plugin.start(ctx)
  optionalConnectors.set(name, plugin)
  changes.push(restartedMessage)
}

export function initConnectors(config: Config, toolCenter: ToolCenter): ConnectorsResult {
  const coreConnectors: Plugin[] = []

  if (config.connectors.mcp.port) {
    coreConnectors.push(new McpServerConnector(toolCenter, {
      host: config.connectors.mcp.host,
      port: config.connectors.mcp.port,
    }))
  }

  if (config.connectors.web.port) {
    coreConnectors.push(new WebConnector({
      host: config.connectors.web.host,
      port: config.connectors.web.port,
      authToken: config.connectors.web.authToken,
    }))
  }

  const optionalConnectors = new Map<string, Plugin>()
  setOptionalConnector(
    optionalConnectors,
    'mcp-ask',
    config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port
      ? createMcpAskConnector(config.connectors.mcpAsk)
      : undefined,
  )
  setOptionalConnector(
    optionalConnectors,
    'telegram',
    config.connectors.telegram.enabled && config.connectors.telegram.botToken
      ? createTelegramConnector(config.connectors.telegram)
      : undefined,
  )

  return { coreConnectors, optionalConnectors }
}

export function createConnectorReconnector(args: {
  coreConnectors: Plugin[]
  optionalConnectors: Map<string, Plugin>
  getCtx: () => EngineContext
}): () => Promise<ReconnectResult> {
  const { coreConnectors, optionalConnectors, getCtx } = args
  let reconnecting = false

  return async (): Promise<ReconnectResult> => {
    if (reconnecting) return { success: false, error: 'Reconnect already in progress' }
    reconnecting = true
    try {
      const fresh = await loadConfig()
      const ctx = getCtx()
      const changes: string[] = []

      // --- Web ---
      const webConnector = coreConnectors.find((plugin) => plugin instanceof WebConnector)
      if (webConnector instanceof WebConnector) {
        const result = await webConnector.reconfigure({
          host: fresh.connectors.web.host,
          port: fresh.connectors.web.port,
          authToken: fresh.connectors.web.authToken,
        })
        if (result === 'updated') changes.push('web updated')
        if (result === 'restarted') changes.push(`web restarted on ${fresh.connectors.web.host}:${fresh.connectors.web.port}`)
      }

      // --- MCP ---
      const mcpConnector = coreConnectors.find((plugin) => plugin instanceof McpServerConnector)
      if (mcpConnector instanceof McpServerConnector) {
        const result = await mcpConnector.reconfigure({
          host: fresh.connectors.mcp.host,
          port: fresh.connectors.mcp.port,
        })
        if (result === 'restarted') changes.push(`mcp restarted on ${fresh.connectors.mcp.host}:${fresh.connectors.mcp.port}`)
      }

      // --- MCP Ask ---
      const mcpAskWanted = fresh.connectors.mcpAsk.enabled && !!fresh.connectors.mcpAsk.port
      await reconcileOptionalConnector({
        optionalConnectors,
        ctx,
        changes,
        name: 'mcp-ask',
        wanted: mcpAskWanted,
        create: () => createMcpAskConnector(fresh.connectors.mcpAsk),
        changed: (plugin) => {
          const currentConfig = plugin instanceof McpAskConnector
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
      await reconcileOptionalConnector({
        optionalConnectors,
        ctx,
        changes,
        name: 'telegram',
        wanted: telegramWanted,
        create: () => createTelegramConnector(fresh.connectors.telegram),
        changed: (plugin) => {
          const currentConfig = plugin instanceof TelegramConnector
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
