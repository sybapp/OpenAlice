import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Tool } from 'ai'
import { createMcpCapabilityTools } from '../../core/capabilities.js'
import type { ToolCenter } from '../../core/tool-center.js'
import type { Plugin, EngineContext } from '../../core/types.js'

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * Convert a tool result to MCP content blocks.
 */
function toMcpContent(result: unknown): McpContent[] {
  if (
    result != null &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const items = (result as { content: Array<Record<string, unknown>> }).content
    const blocks: McpContent[] = []
    for (const item of items) {
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      } else if (item.type === 'text' && typeof item.text === 'string') {
        blocks.push({ type: 'text', text: item.text })
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(item) })
      }
    }
    if ('details' in result && (result as { details: unknown }).details != null) {
      blocks.push({ type: 'text', text: JSON.stringify((result as { details: unknown }).details) })
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: JSON.stringify(result) }]
  }
  return [{ type: 'text', text: JSON.stringify(result) }]
}

/**
 * MCP Plugin — exposes tools via Streamable HTTP.
 *
 * Uses stateful HTTP transport so clients like Codex can initialize once,
 * then call tools/list and tools/call with mcp-session-id.
 */
export class McpPlugin implements Plugin {
  name = 'mcp'
  private server: ReturnType<typeof serve> | null = null
  private transports = new Map<string, WebStandardStreamableHTTPServerTransport>()
  private ctx: EngineContext | null = null

  constructor(
    private toolCenter: ToolCenter,
    private config: { host: string; port: number },
  ) {}

  async start(ctx: EngineContext) {
    this.ctx = ctx
    const resolveTools = async () => ({
      ...(await this.toolCenter.getMcpTools()),
      ...(await createMcpCapabilityTools(ctx)),
    })

    const createMcpServer = async () => {
      const mcp = new McpServer({ name: 'open-alice', version: '1.0.0' })

      for (const [name, t] of Object.entries(await resolveTools())) {
        if (!t.execute) continue

        const shape = (t.inputSchema as any)?.shape ?? {}

        mcp.registerTool(name, {
          description: t.description,
          inputSchema: shape,
        }, async (args: any) => {
          try {
            const result = await t.execute!(args, {
              toolCallId: crypto.randomUUID(),
              messages: [],
            })
            return { content: toMcpContent(result) }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err}` }],
              isError: true,
            }
          }
        })
      }

      return mcp
    }

    const app = new Hono()

    app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    }))

    app.all('/mcp', async (c) => {
      const sessionId = c.req.header('mcp-session-id')
      let transport = sessionId ? this.transports.get(sessionId) : undefined

      if (sessionId && !transport) {
        return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid MCP session id' }, id: null }, 404)
      }

      if (!transport) {
        let initializedSessionId: string | undefined
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            initializedSessionId = sid
            this.transports.set(sid, transport!)
          },
          onsessionclosed: (sid) => {
            this.transports.delete(sid)
          },
        })

        const mcp = await createMcpServer()
        await mcp.connect(transport)

        // Fallback safety in case callbacks are not triggered by client flow.
        if (initializedSessionId && !this.transports.has(initializedSessionId)) {
          this.transports.set(initializedSessionId, transport)
        }
      }

      return transport.handleRequest(c.req.raw)
    })

    this.server = serve({ fetch: app.fetch, hostname: this.config.host, port: this.config.port }, (info) => {
      console.log(`mcp plugin listening on http://${this.config.host}:${info.port}/mcp`)
    })
  }

  async stop() {
    this.transports.clear()
    this.server?.close()
    this.server = null
  }

  getConfig() {
    return this.config
  }

  async reconfigure(nextConfig: { host: string; port: number }): Promise<'restarted' | 'unchanged'> {
    if (this.config.host === nextConfig.host && this.config.port === nextConfig.port) {
      if (!this.server && this.ctx) {
        await this.start(this.ctx)
        return 'restarted'
      }
      return 'unchanged'
    }

    const prev = this.config
    const ctx = this.ctx
    await this.stop()
    this.config = nextConfig
    try {
      if (ctx) {
        await this.start(ctx)
      }
      return 'restarted'
    } catch (err) {
      this.config = prev
      if (!ctx) throw err
      try {
        await this.start(ctx)
      } catch (rollbackErr) {
        const restartMessage = err instanceof Error ? err.message : String(err)
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        throw new Error(`mcp restart failed: ${restartMessage}; rollback failed: ${rollbackMessage}`)
      }
      throw err
    }
  }
}

export { McpPlugin as McpServerConnector }
