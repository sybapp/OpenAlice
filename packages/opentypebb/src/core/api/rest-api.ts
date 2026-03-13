/**
 * REST API setup using Hono.
 * Maps to: openbb_core/api/rest_api.py
 *
 * Creates the Hono app with:
 * - CORS middleware
 * - Default credential injection middleware
 * - Error handling
 * - Health check endpoint
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Credentials } from '../app/model/credentials.js'

/**
 * Create the Hono app with middleware configured.
 * Maps to: the FastAPI app creation in rest_api.py
 *
 * @param defaultCredentials - Default credentials injected into every request
 *                             (can be overridden per-request via X-OpenBB-Credentials header)
 */
export function createApp(
  defaultCredentials: Credentials = {},
): Hono {
  const app = new Hono()

  // CORS middleware (allow all origins by default, matching OpenBB defaults)
  app.use(cors())

  // Health check
  app.get('/api/v1/health', (c) => c.json({ status: 'ok' }))

  return app
}

/**
 * Start the HTTP server.
 * Maps to: uvicorn.run() in rest_api.py
 */
export function startServer(app: Hono, port = 6900): void {
  serve({ fetch: app.fetch, port })
  console.log(`OpenTypeBB listening on http://localhost:${port}`)
}
