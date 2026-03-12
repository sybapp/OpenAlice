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

export interface PluginsResult {
  corePlugins: Plugin[]
  optionalPlugins: Map<string, Plugin>
}

export function initPlugins(config: Config, toolCenter: ToolCenter): PluginsResult {
  const corePlugins: Plugin[] = []

  if (config.connectors.mcp.port) {
    corePlugins.push(new McpPlugin(() => toolCenter.getMcpTools(), config.connectors.mcp.port))
  }

  if (config.connectors.web.port) {
    corePlugins.push(new WebPlugin({ port: config.connectors.web.port, authToken: config.connectors.web.authToken }))
  }

  const optionalPlugins = new Map<string, Plugin>()

  if (config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port) {
    optionalPlugins.set('mcp-ask', new McpAskPlugin({ port: config.connectors.mcpAsk.port, authToken: config.connectors.mcpAsk.authToken }))
  }

  if (config.connectors.telegram.enabled && config.connectors.telegram.botToken) {
    optionalPlugins.set('telegram', new TelegramPlugin({
      token: config.connectors.telegram.botToken,
      allowedChatIds: config.connectors.telegram.chatIds,
    }))
  }

  return { corePlugins, optionalPlugins }
}

export function createConnectorReconnector(
  optionalPlugins: Map<string, Plugin>,
  getCtx: () => EngineContext,
): () => Promise<ReconnectResult> {
  let reconnecting = false

  return async (): Promise<ReconnectResult> => {
    if (reconnecting) return { success: false, error: 'Reconnect already in progress' }
    reconnecting = true
    try {
      const fresh = await loadConfig()
      const ctx = getCtx()
      const changes: string[] = []

      // --- MCP Ask ---
      const mcpAskWanted = fresh.connectors.mcpAsk.enabled && !!fresh.connectors.mcpAsk.port
      const mcpAskRunning = optionalPlugins.has('mcp-ask')
      if (mcpAskRunning && !mcpAskWanted) {
        await optionalPlugins.get('mcp-ask')!.stop()
        optionalPlugins.delete('mcp-ask')
        changes.push('mcp-ask stopped')
      } else if (!mcpAskRunning && mcpAskWanted) {
        const p = new McpAskPlugin({ port: fresh.connectors.mcpAsk.port!, authToken: fresh.connectors.mcpAsk.authToken })
        await p.start(ctx)
        optionalPlugins.set('mcp-ask', p)
        changes.push('mcp-ask started')
      }

      // --- Telegram ---
      const telegramWanted = fresh.connectors.telegram.enabled && !!fresh.connectors.telegram.botToken
      const telegramRunning = optionalPlugins.has('telegram')
      if (telegramRunning && !telegramWanted) {
        await optionalPlugins.get('telegram')!.stop()
        optionalPlugins.delete('telegram')
        changes.push('telegram stopped')
      } else if (!telegramRunning && telegramWanted) {
        const p = new TelegramPlugin({
          token: fresh.connectors.telegram.botToken!,
          allowedChatIds: fresh.connectors.telegram.chatIds,
        })
        await p.start(ctx)
        optionalPlugins.set('telegram', p)
        changes.push('telegram started')
      }

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
