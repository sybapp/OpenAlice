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
  enabled: boolean
  configured: boolean
  create: () => Plugin
  changed: (plugin: Plugin) => boolean
  startedMessage: string
  stoppedMessage: string
  restartedMessage: string
  incompleteMessage: string
}

interface RollbackAction {
  run: () => Promise<void>
}

interface HealthAwarePlugin extends Plugin {
  isHealthy?: () => boolean
}

function setConnectorAlive(optionalConnectors: Map<string, Plugin>, name: string, plugin: Plugin): void {
  optionalConnectors.set(name, plugin)
}

function setConnectorUnknown(optionalConnectors: Map<string, Plugin>, name: string): void {
  optionalConnectors.delete(name)
}

function isPluginHealthy(plugin: Plugin): boolean {
  const healthAware = plugin as HealthAwarePlugin
  return typeof healthAware.isHealthy === 'function' ? healthAware.isHealthy() !== false : true
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

async function reconcileOptionalConnector(args: OptionalConnectorReconcileArgs): Promise<RollbackAction | undefined> {
  const {
    optionalConnectors,
    ctx,
    changes,
    name,
    enabled,
    configured,
    create,
    changed,
    startedMessage,
    stoppedMessage,
    restartedMessage,
    incompleteMessage,
  } = args
  const current = optionalConnectors.get(name)

  if (current && !enabled) {
    await current.stop()
    optionalConnectors.delete(name)
    changes.push(stoppedMessage)
    return {
      run: async () => {
        await current.start(ctx)
        optionalConnectors.set(name, current)
      },
    }
  }

  if (!enabled) return undefined

  if (!configured) {
    console.warn(`reconnect: ${name} ${incompleteMessage}`)
    return undefined
  }

  if (!current) {
    const plugin = create()
    await plugin.start(ctx)
    optionalConnectors.set(name, plugin)
    changes.push(startedMessage)
    return {
      run: async () => {
        try {
          await plugin.stop()
          setConnectorUnknown(optionalConnectors, name)
        } catch (err) {
          setConnectorAlive(optionalConnectors, name, plugin)
          throw err
        }
      },
    }
  }

  if (!changed(current) && isPluginHealthy(current)) return undefined

  const plugin = create()
  await current.stop()
  try {
    await plugin.start(ctx)
    optionalConnectors.set(name, plugin)
    changes.push(restartedMessage)
    return {
      run: async () => {
        try {
          await plugin.stop()
        } catch (err) {
          setConnectorAlive(optionalConnectors, name, plugin)
          throw err
        }

        try {
          await current.start(ctx)
          setConnectorAlive(optionalConnectors, name, current)
        } catch (err) {
          setConnectorUnknown(optionalConnectors, name)
          throw err
        }
      },
    }
  } catch (err) {
    try {
      await current.start(ctx)
      optionalConnectors.set(name, current)
    } catch (rollbackErr) {
      optionalConnectors.delete(name)
      const restartMessage = err instanceof Error ? err.message : String(err)
      const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      throw new Error(`${name} restart failed: ${restartMessage}; rollback failed: ${rollbackMessage}`)
    }
    throw err
  }
}

async function rollbackBatch(actions: RollbackAction[]): Promise<void> {
  const errors: string[] = []

  for (const action of [...actions].reverse()) {
    try {
      await action.run()
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
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
    const rollbackActions: RollbackAction[] = []
    try {
      const fresh = await loadConfig()
      const ctx = getCtx()
      const changes: string[] = []

      // --- Web ---
      const webConnector = coreConnectors.find((plugin) => plugin instanceof WebConnector)
      if (webConnector instanceof WebConnector) {
        const previousConfig = webConnector.getConfig()
        const result = await webConnector.reconfigure({
          host: fresh.connectors.web.host,
          port: fresh.connectors.web.port,
          authToken: fresh.connectors.web.authToken,
        })
        if (result === 'updated') changes.push('web updated')
        if (result === 'restarted') changes.push(`web restarted on ${fresh.connectors.web.host}:${fresh.connectors.web.port}`)
        if (result !== 'unchanged') {
          rollbackActions.push({
            run: async () => {
              await webConnector.reconfigure(previousConfig)
            },
          })
        }
      }

      // --- MCP ---
      const mcpConnector = coreConnectors.find((plugin) => plugin instanceof McpServerConnector)
      if (mcpConnector instanceof McpServerConnector) {
        const previousConfig = mcpConnector.getConfig()
        const result = await mcpConnector.reconfigure({
          host: fresh.connectors.mcp.host,
          port: fresh.connectors.mcp.port,
        })
        if (result === 'restarted') changes.push(`mcp restarted on ${fresh.connectors.mcp.host}:${fresh.connectors.mcp.port}`)
        if (result !== 'unchanged') {
          rollbackActions.push({
            run: async () => {
              await mcpConnector.reconfigure(previousConfig)
            },
          })
        }
      }

      // --- MCP Ask ---
      const mcpAskEnabled = fresh.connectors.mcpAsk.enabled
      const mcpAskConfigured = !!fresh.connectors.mcpAsk.port
      const mcpAskRollback = await reconcileOptionalConnector({
        optionalConnectors,
        ctx,
        changes,
        name: 'mcp-ask',
        enabled: mcpAskEnabled,
        configured: mcpAskConfigured,
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
        incompleteMessage: 'config is incomplete; keeping current connector',
      })
      if (mcpAskRollback) rollbackActions.push(mcpAskRollback)

      // --- Telegram ---
      const telegramEnabled = fresh.connectors.telegram.enabled
      const telegramConfigured = !!fresh.connectors.telegram.botToken
      const telegramRollback = await reconcileOptionalConnector({
        optionalConnectors,
        ctx,
        changes,
        name: 'telegram',
        enabled: telegramEnabled,
        configured: telegramConfigured,
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
        incompleteMessage: 'config is incomplete; keeping current connector',
      })
      if (telegramRollback) rollbackActions.push(telegramRollback)

      if (changes.length > 0) {
        console.log(`reconnect: connectors — ${changes.join(', ')}`)
      }
      return { success: true, message: changes.length > 0 ? changes.join(', ') : 'no changes' }
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err)
      try {
        await rollbackBatch(rollbackActions)
      } catch (rollbackErr) {
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        msg = `${msg}; batch rollback failed: ${rollbackMessage}`
      }
      console.error('reconnect: connectors failed:', msg)
      return { success: false, error: msg }
    } finally {
      reconnecting = false
    }
  }
}
