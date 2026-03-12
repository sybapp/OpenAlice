import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createAuthMiddleware } from './auth-middleware.js'

function buildApp(token: string | undefined) {
  const app = new Hono()
  app.use('*', createAuthMiddleware(token))
  app.get('/test', (c) => c.json({ ok: true }))
  return app
}

describe('createAuthMiddleware', () => {
  describe('with token configured', () => {
    const app = buildApp('secret-token-123')

    it('returns 401 when no Authorization header', async () => {
      const res = await app.request('/test')
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 with wrong token', async () => {
      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer wrong-token' },
      })
      expect(res.status).toBe(401)
    })

    it('passes through with correct token', async () => {
      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer secret-token-123' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })
  })

  describe('without token configured', () => {
    const app = buildApp(undefined)

    it('allows all requests through', async () => {
      const res = await app.request('/test')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })
  })
})
