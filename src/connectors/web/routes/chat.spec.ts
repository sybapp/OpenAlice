import { describe, expect, it, vi } from 'vitest'
import { StreamableResult } from '../../../core/ai-provider.js'
import { createChatRoutes } from './chat.js'

function makeSession() {
  return {
    readActive: vi.fn(async () => []),
    appendAssistant: vi.fn(async () => undefined),
  }
}

describe('createChatRoutes', () => {
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
})
