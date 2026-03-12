import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import type { EngineContext } from '../../../core/types.js'
import { SessionStore, toChatHistory } from '../../../core/session.js'
import { persistMedia, resolveMediaPath } from '../../../core/media-store.js'

export interface SSEClient {
  id: string
  send: (data: string) => void
}

interface ChatDeps {
  ctx: EngineContext
  session: SessionStore
  sseClients: Map<string, SSEClient>
}

/** Chat routes: POST /, GET /history, GET /events (SSE) */
export function createChatRoutes({ ctx, session, sseClients }: ChatDeps) {
  const app = new Hono()

  app.post('/', async (c) => {
    const body = await c.req.json<{ message?: string; requestId?: string }>()
    const message = body.message?.trim()
    if (!message) return c.json({ error: 'message is required' }, 400)
    const requestId = body.requestId?.trim() || randomUUID()

    const receivedEntry = await ctx.eventLog.append('message.received', {
      channel: 'web', to: 'default', prompt: message,
    })

    const resultStream = ctx.engine.askWithSession(message, session, {
      historyPreamble: 'The following is the recent conversation from the Web UI. Use it as context if the user references earlier messages.',
    })

    for await (const event of resultStream) {
      if (event.type === 'done') continue
      const data = JSON.stringify({
        type: 'stream',
        requestId,
        event,
      })
      for (const client of sseClients.values()) {
        try { client.send(data) } catch { /* client disconnected */ }
      }
    }

    const result = await resultStream

    await ctx.eventLog.append('message.sent', {
      channel: 'web', to: 'default', prompt: message,
      reply: result.text, durationMs: Date.now() - receivedEntry.ts,
    })

    // Persist media files with content-addressable 3-word names
    const media: Array<{ type: 'image'; url: string }> = []
    for (const m of result.media ?? []) {
      const name = await persistMedia(m.path)
      media.push({ type: 'image', url: `/api/media/${name}` })
    }

    return c.json({ text: result.text, media, requestId })
  })

  app.get('/history', async (c) => {
    const limit = Number(c.req.query('limit')) || 100
    const entries = await session.readActive()
    return c.json({ messages: toChatHistory(entries).slice(-limit) })
  })

  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const clientId = randomUUID()
      sseClients.set(clientId, {
        id: clientId,
        send: (data) => { stream.writeSSE({ data }).catch(() => {}) },
      })

      const pingInterval = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {
          clearInterval(pingInterval)
          sseClients.delete(clientId)
        })
      }, 30_000)

      // Safety net: cap connection lifetime at 24h
      const maxLifetime = setTimeout(() => {
        clearInterval(pingInterval)
        sseClients.delete(clientId)
        stream.close().catch(() => {})
      }, 24 * 60 * 60 * 1000)

      stream.onAbort(() => {
        clearInterval(pingInterval)
        clearTimeout(maxLifetime)
        sseClients.delete(clientId)
      })

      await new Promise<void>(() => {})
    })
  })

  return app
}

/** Media routes: GET /:name — serves from data/media/ */
export function createMediaRoutes() {
  const app = new Hono()

  const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const NAME_RE = /^[a-z]+-[a-z]+-[a-z]+\.[a-z]+$/

  app.get('/:date/:name', async (c) => {
    const { date, name } = c.req.param()
    if (!DATE_RE.test(date) || !NAME_RE.test(name)) return c.notFound()
    const filePath = resolveMediaPath(join(date, name))

    try {
      const buf = await readFile(filePath)
      const ext = extname(name).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      return c.body(buf, { headers: { 'Content-Type': mime } })
    } catch {
      return c.notFound()
    }
  })

  return app
}
