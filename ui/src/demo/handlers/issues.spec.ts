// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'

import { issuesHandlers } from './issues'

const server = setupServer(...issuesHandlers)
const baseUrl = window.location.origin

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('demo Issue handlers', () => {
  it('round-trips model and effort patches through the detail contract', async () => {
    const response = await fetch(
      `${baseUrl}/api/issues/demo-ws-auto-quant/morning-scan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'openai-primary', model: 'gpt-5.5', effort: 'high' }),
      },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.issue).toMatchObject({
      id: 'morning-scan',
      credential: 'openai-primary',
      model: 'gpt-5.5',
      effort: 'high',
    })
  })

  it('round-trips an optional timeout patch through the detail contract', async () => {
    const response = await fetch(
      `${baseUrl}/api/issues/demo-ws-auto-quant/morning-scan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeout: '45m' }),
      },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.issue).toMatchObject({
      id: 'morning-scan',
      timeout: '45m',
    })
  })
})

describe('demo Issue watch pause', () => {
  it('round-trips a watchPaused patch through the detail contract', async () => {
    const pause = await fetch(
      `${baseUrl}/api/issues/demo-ws-auto-quant/thesis-watch`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ watchPaused: true }),
      },
    )
    expect(pause.status).toBe(200)
    expect((await pause.json()).issue).toMatchObject({ id: 'thesis-watch', watchPaused: true })

    const resume = await fetch(
      `${baseUrl}/api/issues/demo-ws-auto-quant/thesis-watch`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ watchPaused: null }),
      },
    )
    expect(resume.status).toBe(200)
    expect((await resume.json()).issue.watchPaused).toBeUndefined()
  })

  it('rejects a non-boolean watchPaused', async () => {
    const response = await fetch(
      `${baseUrl}/api/issues/demo-ws-auto-quant/thesis-watch`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ watchPaused: 'yes' }),
      },
    )
    expect(response.status).toBe(400)
  })
})
