import { createMiddleware } from 'hono/factory'

export function createAuthMiddleware(token: string | undefined | (() => string | undefined)) {
  const getToken = typeof token === 'function' ? token : () => token

  return createMiddleware(async (c, next) => {
    const currentToken = getToken()
    if (!currentToken) return next()
    if (c.req.path.startsWith('/api/auth/')) return next()

    if (c.req.method === 'GET') {
      const url = new URL(c.req.url)
      if (url.searchParams.get('authToken') === currentToken) {
        return next()
      }
    }

    const header = c.req.header('Authorization')
    if (header !== `Bearer ${currentToken}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  })
}
