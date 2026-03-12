import { createMiddleware } from 'hono/factory'

export function createAuthMiddleware(token: string | undefined) {
  return createMiddleware(async (c, next) => {
    if (!token) return next()
    const header = c.req.header('Authorization')
    if (header !== `Bearer ${token}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  })
}
