import { Hono } from 'hono'
import {
  loadConfig, readMarketDataConfig, writeConfigSection, readAIProviderConfig, validSections,
  writeProfile, deleteProfile, setActiveProfile,
  profileSchema, type ConfigSection, type Profile,
} from '../../core/config.js'
import type { EngineContext } from '../../core/types.js'
import { BUILTIN_PRESETS } from '../../ai-providers/presets.js'
import { getSdkAdapterInfo } from '../../ai-providers/sdk-adapters.js'
import {
  addMarketDataAlert,
  addMarketDataWatch,
  listMarketDataAlertRuns,
  listMarketDataAlerts,
  listMarketDataWatchWithCache,
  normalizeAlertRunsQuery,
  providerFor,
  readMarketDataAlertStateSummary,
  readOhlcvCacheStatus,
  recordMarketDataAlertFeedback,
  removeMarketDataAlert,
  removeMarketDataWatch,
  setMarketDataAlertsEnabled,
  setMarketDataWatchEnabled,
} from '../../domain/market-data/ohlcv/index.js'

interface ConfigRouteOpts {
  ctx?: EngineContext
  onConnectorsChange?: () => Promise<void>
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
      const result = await opts.ctx.agentCenter.testWithProfile(validated, 'Hi')
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
      // Hot-reload connectors / OpenBB server when their config changes
      if (section === 'connectors' || section === 'marketData') {
        await opts?.onConnectorsChange?.()
      }
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
  const TEST_ENDPOINTS: Record<string, { credField: string; provider: string; model: string; params: Record<string, unknown> }> = {
    fred:             { credField: 'federal_reserve_api_key',  provider: 'federal_reserve', model: 'FredSearch',              params: { query: 'GDP' } },
    bls:              { credField: 'bls_api_key',              provider: 'bls',              model: 'BlsSearch',               params: { query: 'unemployment' } },
    eia:              { credField: 'eia_api_key',              provider: 'eia',              model: 'ShortTermEnergyOutlook',  params: {} },
    econdb:           { credField: 'econdb_api_key',           provider: 'econdb',           model: 'AvailableIndicators',     params: {} },
    fmp:              { credField: 'fmp_api_key',              provider: 'fmp',              model: 'EquityScreener',          params: { limit: 1 } },
    intrinio:         { credField: 'intrinio_api_key',         provider: 'intrinio',         model: 'EquitySearch',            params: { query: 'AAPL', limit: 1 } },
  }

  const app = new Hono()

  app.get('/watch', async (c) => {
    try {
      return c.json(await listMarketDataWatchWithCache(await readMarketDataConfig()))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.post('/watch', async (c) => {
    try {
      const body = await c.req.json()
      const { next, result } = addMarketDataWatch(await readMarketDataConfig(), {
        asset: body.asset,
        symbol: body.symbol,
        intervals: body.intervals,
        provider: body.provider,
        lookbackBars: body.lookbackBars ?? 300,
        enableWatch: body.enableWatch ?? true,
      })
      await writeConfigSection('marketData', next)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete('/watch', async (c) => {
    try {
      const body = await c.req.json()
      const { next, result } = removeMarketDataWatch(await readMarketDataConfig(), {
        asset: body.asset,
        symbol: body.symbol,
        provider: body.provider,
        intervals: body.intervals,
      })
      await writeConfigSection('marketData', next)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/watch/enabled', async (c) => {
    try {
      const body = await c.req.json()
      const { next, result } = setMarketDataWatchEnabled(await readMarketDataConfig(), {
        enabled: Boolean(body.enabled),
        every: typeof body.every === 'string' ? body.every : undefined,
      })
      await writeConfigSection('marketData', next)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/watch/run', async (c) => {
    if (!ctx.runMarketDataWatchNow) return c.json({ error: 'Market data watcher is not available' }, 503)
    return c.json(await ctx.runMarketDataWatchNow())
  })

  app.get('/alerts', async (c) => {
    try {
      return c.json(listMarketDataAlerts(await readMarketDataConfig()))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.post('/alerts', async (c) => {
    try {
      const body = await c.req.json()
      const { next, result } = addMarketDataAlert(await readMarketDataConfig(), {
        asset: body.asset,
        symbol: body.symbol,
        interval: body.interval ?? '5m',
        provider: body.provider,
        enabled: body.enabled ?? true,
        mode: body.mode,
        lookbackBars: body.lookbackBars ?? 300,
        cooldownMinutes: body.cooldownMinutes,
        maxSignalAgeBars: body.maxSignalAgeBars ?? 3,
        minVolumeScore: body.minVolumeScore,
        options: body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : undefined,
        enableAlerts: body.enableAlerts ?? true,
        ensureWatch: body.ensureWatch ?? true,
      })
      await writeConfigSection('marketData', next)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete('/alerts', async (c) => {
    try {
      const body = await c.req.json()
      const { next, result } = removeMarketDataAlert(await readMarketDataConfig(), {
        asset: body.asset,
        symbol: body.symbol,
        interval: body.interval,
        provider: body.provider,
      })
      await writeConfigSection('marketData', next)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/alerts/enabled', async (c) => {
    try {
      const body = await c.req.json()
      const { next, result } = setMarketDataAlertsEnabled(await readMarketDataConfig(), {
        enabled: Boolean(body.enabled),
        every: typeof body.every === 'string' ? body.every : undefined,
        mode: body.mode,
      })
      await writeConfigSection('marketData', next)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/alerts/run', async (c) => {
    if (!ctx.runMarketDataAlertsNow) return c.json({ error: 'Market data alerts are not available' }, 503)
    return c.json(await ctx.runMarketDataAlertsNow())
  })

  app.get('/alerts/history', async (c) => {
    const limit = Number(c.req.query('limit')) || 100
    return c.json(await ctx.notificationsStore.read({ limit, source: 'task' }))
  })

  app.get('/alerts/state', async (c) => {
    return c.json(await readMarketDataAlertStateSummary())
  })

  app.get('/alerts/runs', async (c) => {
    try {
      return c.json(await listMarketDataAlertRuns(normalizeAlertRunsQuery({
        limit: Number(c.req.query('limit')) || undefined,
        asset: c.req.query('asset') as never,
        symbol: c.req.query('symbol') ?? undefined,
        interval: c.req.query('interval') ?? undefined,
        status: c.req.query('status') as never,
      })))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/alerts/runs/:runId/feedback', async (c) => {
    try {
      const runId = c.req.param('runId')
      const body = await c.req.json()
      if (!['useful', 'false_positive', 'ignored', 'needs_tuning'].includes(body.rating)) {
        return c.json({ error: 'Invalid feedback rating' }, 400)
      }
      const result = await recordMarketDataAlertFeedback({
        runId,
        rating: body.rating,
        note: body.note,
      })
      return c.json(result, result.ok ? 200 : 404)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get('/cache/status', async (c) => {
    try {
      const config = await readMarketDataConfig()
      const asset = c.req.query('asset') as 'equity' | 'crypto' | 'currency' | 'commodity'
      const symbol = c.req.query('symbol')
      const interval = c.req.query('interval')
      const provider = c.req.query('provider')
      if (!asset || !symbol || !interval) return c.json({ error: 'asset, symbol, and interval are required' }, 400)
      return c.json(await readOhlcvCacheStatus({
        cacheDir: config.ohlcvCache.dir,
        asset,
        symbol,
        interval: asset === 'commodity' ? '1d' : interval,
        provider: providerFor(config, asset, provider),
      }))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/test-provider', async (c) => {
    try {
      const { provider, key } = await c.req.json<{ provider: string; key: string }>()
      const endpoint = TEST_ENDPOINTS[provider]
      if (!endpoint) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400)
      if (!key) return c.json({ ok: false, error: 'No API key provided' }, 400)

      const result = await ctx.bbEngine.execute(
        endpoint.provider, endpoint.model, endpoint.params,
        { [endpoint.credField]: key },
      )
      const data = result as unknown[]
      if (data && data.length > 0) return c.json({ ok: true })
      return c.json({ ok: false, error: 'API returned empty data — key may be invalid or endpoint restricted' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: msg })
    }
  })

  return app
}
