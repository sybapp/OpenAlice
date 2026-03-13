import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamableResult } from '../../../core/ai-provider.js'
import { createChatRoutes, createMediaRoutes } from './chat.js'

function makeSession() {
  return {
    readActive: vi.fn(async () => []),
    appendAssistant: vi.fn(async () => undefined),
  }
}

describe('createChatRoutes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('streams provider events to SSE clients with requestId and returns the final response', async () => {
    const send = vi.fn()
    const sseClients = new Map([
      ['client-1', { id: 'client-1', send }],
    ])
    const session = makeSession()
    const append = vi.fn()

    const app = createChatRoutes({
      ctx: {
        eventLog: {
          append: append
            .mockResolvedValueOnce({ ts: 1000 })
            .mockResolvedValueOnce({ ts: 1100 }),
        },
        engine: {
          askWithSession: vi.fn(() => new StreamableResult((async function* () {
            yield { type: 'tool_use' as const, id: 'tool-1', name: 'Read', input: { file: 'README.md' } }
            yield { type: 'text' as const, text: 'partial answer' }
            yield { type: 'done' as const, result: { text: 'final answer', media: [] } }
          })())),
        },
      } as never,
      session: session as never,
      sseClients,
    })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', requestId: 'req-123' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      text: 'final answer',
      media: [],
      requestId: 'req-123',
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, JSON.stringify({
      type: 'stream',
      requestId: 'req-123',
      event: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'README.md' } },
    }))
    expect(send).toHaveBeenNthCalledWith(2, JSON.stringify({
      type: 'stream',
      requestId: 'req-123',
      event: { type: 'text', text: 'partial answer' },
    }))

    expect(append).toHaveBeenNthCalledWith(1, 'message.received', {
      channel: 'web',
      to: 'default',
      prompt: 'hello',
    })
    expect(append).toHaveBeenNthCalledWith(2, 'message.sent', expect.objectContaining({
      channel: 'web',
      to: 'default',
      prompt: 'hello',
      reply: 'final answer',
      durationMs: expect.any(Number),
    }))
  })

  it('persists returned media into session history for reloads', async () => {
    const session = makeSession()
    const app = createChatRoutes({
      ctx: {
        eventLog: {
          append: vi.fn()
            .mockResolvedValueOnce({ ts: 1000 })
            .mockResolvedValueOnce({ ts: 1100 }),
        },
        engine: {
          askWithSession: vi.fn(() => new StreamableResult((async function* () {
            yield {
              type: 'done' as const,
              result: {
                text: 'final answer',
                media: [{ type: 'image' as const, path: '/tmp/chat-image.png' }],
              },
            }
          })())),
        },
      } as never,
      session: session as never,
      sseClients: new Map(),
    })

    const mediaStore = await import('../../../core/media-store.js')
    const persistSpy = vi.spyOn(mediaStore, 'persistMedia').mockResolvedValue('2026-03-13/chat-image.png')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', requestId: 'req-media' }),
    })

    expect(res.status).toBe(200)
    expect(session.appendAssistant).toHaveBeenCalledWith(
      [{ type: 'image', url: '/api/media/2026-03-13/chat-image.png' }],
      'engine',
    )

    persistSpy.mockRestore()
  })

  it('rejects empty chat messages with a 400 response', async () => {
    const session = makeSession()
    const app = createChatRoutes({
      ctx: {
        eventLog: { append: vi.fn() },
        engine: { askWithSession: vi.fn() },
      } as never,
      session: session as never,
      sseClients: new Map(),
    })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'message is required' })
  })
})

describe('createMediaRoutes', () => {
  it('serves persisted images and rejects invalid paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openalice-media-'))
    const mediaFile = join(tempDir, 'sample.png')
    await writeFile(mediaFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const mediaStore = await import('../../../core/media-store.js')
    const resolveSpy = vi.spyOn(mediaStore, 'resolveMediaPath').mockImplementation((name) => {
      if (name === '2026-03-13/ace-aim-air.png') return mediaFile
      throw new Error('invalid media path')
    })

    const app = createMediaRoutes()

    const ok = await app.request('/2026-03-13/ace-aim-air.png')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('image/png')

    const notFound = await app.request('/../../etc/passwd')
    expect(notFound.status).toBe(404)

    resolveSpy.mockRestore()
    await rm(tempDir, { recursive: true, force: true })
  })
})
