import { Hono } from 'hono'
import {
  loadConfig, writeConfigSection, readAIProviderConfig, validSections,
  writeProfile, deleteProfile, setActiveProfile,
  profileSchema, type ConfigSection, type Profile,
} from '../../core/config.js'
import type { EngineContext } from '../../core/types.js'
import { BUILTIN_PRESETS } from '../../ai-providers/presets.js'
import { getSdkAdapterInfo } from '../../ai-providers/sdk-adapters.js'
import { testWithProfile } from '../../core/ai-config.js'
import type { MarketDataQueryInput, MarketDataService } from '../../services/market-data/index.js'

interface ConfigRouteOpts {
  ctx?: EngineContext
}

/** Config routes: GET /, PUT /:section, profile CRUD, presets, test */
export function createConfigRoutes(opts?: ConfigRouteOpts) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const config = await loadConfig()
      return c.json(config)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Profile CRUD ====================

  /** GET /profiles — list profiles + credentials map + active profile slug */
  app.get('/profiles', async (c) => {
    try {
      const config = await readAIProviderConfig()
      return c.json({
        profiles: config.profiles,
        credentials: config.credentials,
        activeProfile: config.activeProfile,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  /** GET /sdk-adapters — list SDK adapters with their preset associations */
  app.get('/sdk-adapters', (c) => c.json({ adapters: getSdkAdapterInfo() }))

  /** POST /profiles — create a new profile */
  app.post('/profiles', async (c) => {
    try {
      const body = await c.req.json<{ slug: string; profile: Profile }>()
      if (!body.slug?.trim()) {
        return c.json({ error: 'Profile name is required' }, 400)
      }
      const config = await readAIProviderConfig()
      if (config.profiles[body.slug]) {
        return c.json({ error: 'profile slug already exists' }, 409)
      }
      const validated = profileSchema.parse(body.profile)
      await writeProfile(body.slug, validated)
      return c.json({ slug: body.slug, profile: validated }, 201)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  /** PUT /profiles/:slug — update a profile */
  app.put('/profiles/:slug', async (c) => {
    try {
      const slug = c.req.param('slug')
      const body = await c.req.json<Profile>()
      const validated = profileSchema.parse(body)
      await writeProfile(slug, validated)
      return c.json({ slug, profile: validated })
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  /** DELETE /profiles/:slug — delete a profile */
  app.delete('/profiles/:slug', async (c) => {
    try {
      const slug = c.req.param('slug')
      await deleteProfile(slug)
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** PUT /active-profile — set the active profile */
  app.put('/active-profile', async (c) => {
    try {
      const { slug } = await c.req.json<{ slug: string }>()
      await setActiveProfile(slug)
      return c.json({ activeProfile: slug })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  // ==================== Presets ====================

  /** GET /presets — built-in preset templates for profile creation */
  app.get('/presets', (c) => c.json({ presets: BUILTIN_PRESETS }))

  // ==================== Profile Test ====================

  /** POST /profiles/test — test profile config by sending "Hi" (without saving) */
  app.post('/profiles/test', async (c) => {
    if (!opts?.ctx) return c.json({ ok: false, error: 'Test not available' }, 500)
    try {
      const profileData = await c.req.json<Profile>()
      const validated = profileSchema.parse(profileData)
      const result = await testWithProfile(opts.ctx.router, validated, 'Hi')
      return c.json({ ok: true, response: result.text })
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ==================== Generic Section Writer ====================

  app.put('/:section', async (c) => {
    try {
      const section = c.req.param('section') as ConfigSection
      if (!validSections.includes(section)) {
        return c.json({ error: `Invalid section "${section}". Valid: ${validSections.join(', ')}` }, 400)
      }
      const body = await c.req.json()
      const validated = await writeConfigSection(section, body)
      // Keep the in-memory ctx.config in sync with disk so any code path
      // reading it (opentypebb resolver, market-data helpers, …) picks up
      // edits without a restart. Object.assign preserves ctx.config's
      // object identity — we just swap its contents.
      if (opts?.ctx) {
        const fresh = await loadConfig()
        Object.assign(opts.ctx.config, fresh)
      }
      // marketData edits are picked up lazily by the opentypebb resolver
      // (it reads ctx.config per request), so no explicit hot-reload hook
      // is needed. The old connector hot-reload path was removed with the
      // legacy connector cluster.
      return c.json(validated)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}

/** Market data routes: POST /test-provider */
export function createMarketDataRoutes(ctx: EngineContext) {
  const marketDataService = ctx.marketDataService
  const TEST_ENDPOINTS: Record<string, { credField: string; provider: string; endpoint: string; params: Record<string, unknown> }> = {
    fred:             { credField: 'federal_reserve_api_key', provider: 'federal_reserve', endpoint: '/economy/fred_search',                params: { query: 'GDP' } },
    bls:              { credField: 'bls_api_key',             provider: 'bls',              endpoint: '/economy/survey/bls_search',        params: { query: 'unemployment' } },
    eia:              { credField: 'eia_api_key',             provider: 'eia',              endpoint: '/commodity/short_term_energy_outlook', params: {} },
    econdb:           { credField: 'econdb_api_key',          provider: 'econdb',           endpoint: '/economy/available_indicators',    params: {} },
    fmp:              { credField: 'fmp_api_key',             provider: 'fmp',              endpoint: '/equity/screener',                 params: { limit: 1 } },
    intrinio:         { credField: 'intrinio_api_key',        provider: 'intrinio',         endpoint: '/equity/search',                   params: { query: 'AAPL', limit: 1 } },
  }

  function queryInputFromUrl(url: string): MarketDataQueryInput {
    const searchParams = new URL(url).searchParams
    const endpoint = searchParams.get('endpoint') ?? ''
    const provider = searchParams.get('provider') ?? undefined
    const limitRaw = searchParams.get('limit')
    const params: Record<string, unknown> = {}
    for (const [key, value] of searchParams.entries()) {
      if (key !== 'endpoint' && key !== 'provider' && key !== 'limit') {
        params[key] = value
      }
    }
    return {
      endpoint,
      provider,
      limit: limitRaw ? Number(limitRaw) : undefined,
      params,
    }
  }

  async function executeQuery(service: MarketDataService, input: MarketDataQueryInput) {
    return await service.query(input)
  }

  const app = new Hono()

  app.get('/query', async (c) => {
    try {
      return c.json(await executeQuery(marketDataService, queryInputFromUrl(c.req.url)))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.post('/query', async (c) => {
    try {
      const body = await c.req.json<MarketDataQueryInput>()
      return c.json(await executeQuery(marketDataService, body))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.post('/test-provider', async (c) => {
    try {
      const { provider, key } = await c.req.json<{ provider: string; key: string }>()
      if (provider === 'tradingview_sessionid') {
        const result = await marketDataService.scan({
          limit: 1,
          credentials: { tradingview_sessionid: key },
        })
        if (result.rows.length > 0) return c.json({ ok: true })
        return c.json({ ok: false, error: result.error ?? 'TradingView scanner returned empty data' })
      }
      const endpoint = TEST_ENDPOINTS[provider]
      if (!endpoint) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400)
      if (!key) return c.json({ ok: false, error: 'No API key provided' }, 400)

      const result = await marketDataService.query({
        endpoint: endpoint.endpoint,
        provider: endpoint.provider,
        params: endpoint.params,
        limit: 1,
        credentials: { [endpoint.credField]: key },
      })
      if (result.rows.length > 0) return c.json({ ok: true })
      if (result.error) return c.json({ ok: false, error: result.error })
      return c.json({ ok: false, error: 'API returned empty data — key may be invalid or endpoint restricted' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: msg })
    }
  })

  return app
}
