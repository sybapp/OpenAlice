import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { resolve } from 'node:path'
import type { Plugin, EngineContext } from '../../core/types.js'
import { SessionStore, type ContentBlock } from '../../core/session.js'
import type { ConnectorCenter, Connector } from '../../core/connector-center.js'
import { persistMedia } from '../../core/media-store.js'
import { createAuthMiddleware } from './auth-middleware.js'
import { createChatRoutes, createMediaRoutes, type SSEClient } from './routes/chat.js'
import { createConfigRoutes } from './routes/config.js'
import { createEventsRoutes } from './routes/events.js'
import { createCronRoutes } from './routes/cron.js'
import { createHeartbeatRoutes } from './routes/heartbeat.js'
import { createTradingRoutes } from './routes/trading.js'
import { createTradingConfigRoutes } from './routes/trading-config.js'
import { createDevRoutes } from './routes/dev.js'
import { createToolsRoutes } from './routes/tools.js'
import { createBacktestRoutes } from './routes/backtest.js'
import { createStrategiesRoutes } from './routes/strategies.js'

export interface WebConfig {
  host: string
  port: number
  authToken?: string
}

function createWebApp(args: {
  ctx: EngineContext
  session: SessionStore
  sseClients: Map<string, SSEClient>
  getAuthToken: () => string | undefined
}): Hono {
  const { ctx, session, sseClients, getAuthToken } = args
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    console.error('web: unhandled error:', err)
    return c.json({ error: err.message }, 500)
  })

  const authToken = getAuthToken()
  if (!authToken) {
    console.warn('web: ⚠ no authToken configured — API is open to all network traffic')
  }

  app.use('/api/*', cors({
    origin: authToken ? (origin) => origin : '*',
    credentials: !!authToken,
  }))
  app.use('/api/*', createAuthMiddleware(getAuthToken))

  app.get('/api/auth/check', (c) => {
    return c.json({ authRequired: !!getAuthToken() })
  })
  app.post('/api/auth/verify', async (c) => {
    const currentToken = getAuthToken()
    if (!currentToken) return c.json({ valid: true })
    const body = await c.req.json<{ token?: string }>()
    return c.json({ valid: body.token === currentToken })
  })

  app.route('/api/chat', createChatRoutes({ ctx, session, sseClients }))
  app.route('/api/media', createMediaRoutes())
  app.route('/api/config', createConfigRoutes({
    onConnectorsChange: async () => { await ctx.reconnectConnectors() },
  }))
  app.route('/api/events', createEventsRoutes(ctx))
  app.route('/api/cron', createCronRoutes(ctx))
  app.route('/api/strategies', createStrategiesRoutes(ctx))
  app.route('/api/heartbeat', createHeartbeatRoutes(ctx))
  app.route('/api/trading/config', createTradingConfigRoutes(ctx))
  app.route('/api/trading', createTradingRoutes(ctx))
  app.route('/api/backtest', createBacktestRoutes(ctx))
  app.route('/api/dev', createDevRoutes(ctx.connectorCenter))
  app.route('/api/tools', createToolsRoutes(ctx.toolCenter))

  const uiRoot = resolve('dist/web')
  app.use('/*', serveStatic({ root: uiRoot }))
  app.get('*', serveStatic({ root: uiRoot, path: 'index.html' }))

  return app
}

export class WebPlugin implements Plugin {
  name = 'web'
  private server: ReturnType<typeof serve> | null = null
  private sseClients = new Map<string, SSEClient>()
  private unregisterConnector?: () => void
  private ctx: EngineContext | null = null

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    this.ctx = ctx
    // Initialize session (mirrors Telegram's per-user pattern, single user for web)
    const session = new SessionStore('web/default')
    await session.restore()

    const getAuthToken = () => this.config.authToken
    const app = createWebApp({
      ctx,
      session,
      sseClients: this.sseClients,
      getAuthToken,
    })

    // ==================== Connector registration ====================
    this.unregisterConnector = ctx.connectorCenter.register(
      this.createConnector(this.sseClients, session),
    )

    // ==================== Start server ====================
    this.server = serve({ fetch: app.fetch, hostname: this.config.host, port: this.config.port }, (info: { port: number }) => {
      console.log(`web plugin listening on http://${this.config.host}:${info.port}`)
    })
  }

  async stop() {
    this.sseClients.clear()
    this.unregisterConnector?.()
    this.server?.close()
    this.server = null
  }

  async reconfigure(nextConfig: WebConfig): Promise<'updated' | 'restarted' | 'unchanged'> {
    const prev = this.config
    this.config = nextConfig

    if (prev.port === nextConfig.port && prev.host === nextConfig.host) {
      return prev.authToken === nextConfig.authToken ? 'unchanged' : 'updated'
    }

    const ctx = this.ctx
    await this.stop()
    if (ctx) {
      await this.start(ctx)
    }
    return 'restarted'
  }

  private createConnector(
    sseClients: Map<string, SSEClient>,
    session: SessionStore,
  ): Connector {
    return {
      channel: 'web',
      to: 'default',
      capabilities: { push: true, media: true },
      send: async (payload) => {
        // Persist media to data/media/ with 3-word names
        const media: Array<{ type: 'image'; url: string }> = []
        for (const m of payload.media ?? []) {
          const name = await persistMedia(m.path)
          media.push({ type: 'image', url: `/api/media/${name}` })
        }

        const data = JSON.stringify({
          type: 'message',
          kind: payload.kind,
          text: payload.text,
          media: media.length > 0 ? media : undefined,
          source: payload.source,
        })

        for (const client of sseClients.values()) {
          try { client.send(data) } catch { /* client disconnected */ }
        }

        // Persist to session so history survives page refresh (text + image blocks)
        const blocks: ContentBlock[] = [
          { type: 'text', text: payload.text },
          ...media.map((m) => ({ type: 'image' as const, url: m.url })),
        ]
        await session.appendAssistant(blocks, 'engine', {
          kind: payload.kind,
          source: payload.source,
        })

        return { delivered: sseClients.size > 0 }
      },
    }
  }
}
