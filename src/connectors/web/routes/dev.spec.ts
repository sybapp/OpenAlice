import { describe, expect, it, vi } from 'vitest'
import { createDevRoutes } from './dev.js'

function makeArgs() {
  return {
    connectorCenter: {
      list: vi.fn(() => []),
      getLastInteraction: vi.fn(() => null),
      get: vi.fn(),
      notify: vi.fn(),
    },
    ctx: {
      eventLog: {
        read: vi.fn(async () => [{ seq: 1 }, { seq: 2 }]),
        clear: vi.fn(async () => undefined),
      },
      brain: {
        exportState: vi.fn(() => ({ commits: [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }] })),
        reset: vi.fn(() => ({ success: true })),
      },
    },
    session: {
      readAll: vi.fn(async () => [{ type: 'user' }, { type: 'assistant' }]),
      clear: vi.fn(async () => undefined),
    },
  } as any
}

describe('createDevRoutes', () => {
  it('clears web chat history', async () => {
    const args = makeArgs()
    const app = createDevRoutes(args)

    const res = await app.request('/runtime/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'chat' }),
    })

    expect(res.status).toBe(200)
    expect(args.session.clear).toHaveBeenCalledOnce()
    expect(await res.json()).toMatchObject({
      target: 'chat',
      removedEntries: 2,
    })
  })

  it('clears the event log', async () => {
    const args = makeArgs()
    const app = createDevRoutes(args)

    const res = await app.request('/runtime/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'events' }),
    })

    expect(res.status).toBe(200)
    expect(args.ctx.eventLog.clear).toHaveBeenCalledOnce()
    expect(await res.json()).toMatchObject({
      target: 'events',
      removedEntries: 2,
    })
  })

  it('resets brain memory', async () => {
    const args = makeArgs()
    const app = createDevRoutes(args)

    const res = await app.request('/runtime/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'brain' }),
    })

    expect(res.status).toBe(200)
    expect(args.ctx.brain.reset).toHaveBeenCalledOnce()
    expect(await res.json()).toMatchObject({
      target: 'brain',
      removedEntries: 3,
    })
  })

  it('rejects unknown clear targets', async () => {
    const args = makeArgs()
    const app = createDevRoutes(args)

    const res = await app.request('/runtime/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'unknown' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'target must be one of: chat, events, brain',
    })
  })
})
