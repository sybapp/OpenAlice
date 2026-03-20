import { Hono } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import {
  readPlatformsConfig, writePlatformsConfig,
  readAccountsConfig, writeAccountsConfig,
  platformConfigSchema, accountConfigSchema,
} from '../../../core/config.js'
import { isRecord, mergeSecretField, withSecretPresence } from './secret-fields.js'
import { getValidationErrorPayload } from './zod-error.js'

type TradingAccountConfig = Awaited<ReturnType<typeof readAccountsConfig>>[number]

function upsertById<T extends { id: string }>(items: T[], next: T): void {
  const index = items.findIndex((item) => item.id === next.id)
  if (index >= 0) {
    items[index] = next
    return
  }
  items.push(next)
}

function toClientAccount(a: TradingAccountConfig) {
  return withSecretPresence({
    id: a.id,
    platformId: a.platformId,
    label: a.label,
    apiKey: a.apiKey,
    apiSecret: a.apiSecret,
    password: a.password,
    guards: a.guards,
  }, {
    apiKey: 'hasApiKey',
    apiSecret: 'hasApiSecret',
    password: 'hasPassword',
  })
}

function buildAccountConfig(id: string, body: Record<string, unknown>, existing?: TradingAccountConfig): TradingAccountConfig {
  return {
    id,
    platformId: typeof body.platformId === 'string' ? body.platformId : existing?.platformId ?? '',
    label: typeof body.label === 'string' ? body.label : existing?.label,
    guards: Array.isArray(body.guards) ? body.guards : existing?.guards ?? [],
    apiKey: mergeSecretField(existing?.apiKey, body, 'apiKey'),
    apiSecret: mergeSecretField(existing?.apiSecret, body, 'apiSecret'),
    password: mergeSecretField(existing?.password, body, 'password'),
  }
}

async function reconnectAccounts(ctx: EngineContext, accountIds: string[]) {
  return Promise.all(
    accountIds.map(async (accountId) => ({ id: accountId, ...(await ctx.reconnectAccount(accountId)) })),
  )
}

/** Trading config CRUD routes: platforms + accounts */
export function createTradingConfigRoutes(ctx: EngineContext) {
  const app = new Hono()

  // ==================== Read all ====================

  app.get('/', async (c) => {
    try {
      const [platforms, accounts] = await Promise.all([
        readPlatformsConfig(),
        readAccountsConfig(),
      ])
      return c.json({ platforms, accounts: accounts.map(toClientAccount) })
    } catch (err) {
      return c.json({ error: String(err) }, { status: 500 })
    }
  })

  // ==================== Platforms CRUD ====================

  app.put('/platforms/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()
      if (body.id !== id) {
        return c.json({ error: 'Body id must match URL id' }, { status: 400 })
      }
      const validated = platformConfigSchema.parse(body)
      const platforms = await readPlatformsConfig()
      upsertById(platforms, validated)
      await writePlatformsConfig(platforms)

      // Reconnect all running accounts that reference this platform
      const accounts = await readAccountsConfig()
      const affectedIds = accounts
        .filter((a) => a.platformId === id)
        .map((a) => a.id)
        .filter((aid) => ctx.accountManager.has(aid))
      if (affectedIds.length > 0) {
        const reconnectResults = await reconnectAccounts(ctx, affectedIds)
        return c.json({ ...validated, reconnected: reconnectResults })
      }
      return c.json(validated)
    } catch (err) {
      const validationError = getValidationErrorPayload(err)
      if (validationError) {
        return c.json(validationError, { status: 400 })
      }
      return c.json({ error: String(err) }, { status: 500 })
    }
  })

  app.delete('/platforms/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const [platforms, accounts] = await Promise.all([
        readPlatformsConfig(),
        readAccountsConfig(),
      ])
      const refs = accounts.filter((a) => a.platformId === id)
      if (refs.length > 0) {
        return c.json({
          error: `Platform "${id}" is referenced by ${refs.length} account(s): ${refs.map((a) => a.id).join(', ')}. Remove them first.`,
        }, { status: 400 })
      }
      const filtered = platforms.filter((p) => p.id !== id)
      if (filtered.length === platforms.length) {
        return c.json({ error: `Platform "${id}" not found` }, { status: 404 })
      }
      await writePlatformsConfig(filtered)
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, { status: 500 })
    }
  })

  // ==================== Accounts CRUD ====================

  app.put('/accounts/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json<Record<string, unknown>>()
      if (body.id !== id) {
        return c.json({ error: 'Body id must match URL id' }, { status: 400 })
      }

      const accounts = await readAccountsConfig()
      const existing = accounts.find((a) => a.id === id)
      const input = isRecord(body) ? body : {}
      const merged = buildAccountConfig(id, input, existing)

      const validated = accountConfigSchema.parse(merged)

      // Validate platformId reference
      const platforms = await readPlatformsConfig()
      if (!platforms.some((p) => p.id === validated.platformId)) {
        return c.json({ error: `Platform "${validated.platformId}" not found` }, { status: 400 })
      }

      upsertById(accounts, validated)
      await writeAccountsConfig(accounts)

      // Reconnect running account if config changed
      if (ctx.accountManager.has(id)) {
        const reconnectResult = await ctx.reconnectAccount(id)
        return c.json({ ...toClientAccount(validated), reconnect: reconnectResult })
      }
      return c.json(toClientAccount(validated))
    } catch (err) {
      const validationError = getValidationErrorPayload(err)
      if (validationError) {
        return c.json(validationError, { status: 400 })
      }
      return c.json({ error: String(err) }, { status: 500 })
    }
  })

  app.delete('/accounts/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const accounts = await readAccountsConfig()
      const filtered = accounts.filter((a) => a.id !== id)
      if (filtered.length === accounts.length) {
        return c.json({ error: `Account "${id}" not found` }, { status: 404 })
      }
      await writeAccountsConfig(filtered)
      // Close running account instance if any
      if (ctx.accountManager.has(id)) {
        await ctx.removeTradingAccountRuntime(id)
      }
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, { status: 500 })
    }
  })

  return app
}
