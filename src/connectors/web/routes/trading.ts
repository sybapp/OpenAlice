import { Hono, type Context } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import type { ITradingAccount } from '../../../extension/trading/interfaces.js'
import type { ITradingGit } from '../../../extension/trading/git/interfaces.js'

/** Unified trading routes — works with all account types via AccountManager */
export function createTradingRoutes(ctx: EngineContext) {
  const app = new Hono()

  function getAccountOrError(c: Context): ITradingAccount | Response {
    const account = ctx.accountManager.getAccount(c.req.param('id'))
    return account ?? c.json({ error: 'Account not found' }, 404)
  }

  function getTradingGitOrError(c: Context): ITradingGit | Response {
    const git = ctx.getAccountGit(c.req.param('id'))
    return git ?? c.json({ error: 'Account or trading history not found' }, 404)
  }

  // ==================== Accounts listing ====================

  app.get('/accounts', (c) => {
    return c.json({ accounts: ctx.accountManager.listAccounts() })
  })

  // ==================== Aggregated equity ====================

  app.get('/equity', async (c) => {
    try {
      const equity = await ctx.accountManager.getAggregatedEquity()
      return c.json(equity)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Per-account routes ====================

  // Reconnect
  app.post('/accounts/:id/reconnect', async (c) => {
    const id = c.req.param('id')
    const result = await ctx.reconnectAccount(id)
    return c.json(result, result.success ? 200 : 500)
  })

  // Account info
  app.get('/accounts/:id/account', async (c) => {
    const account = getAccountOrError(c)
    if (account instanceof Response) return account
    try {
      return c.json(await account.getAccount())
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // Positions
  app.get('/accounts/:id/positions', async (c) => {
    const account = getAccountOrError(c)
    if (account instanceof Response) return account
    try {
      const positions = await account.getPositions()
      return c.json({ positions })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // Orders
  app.get('/accounts/:id/orders', async (c) => {
    const account = getAccountOrError(c)
    if (account instanceof Response) return account
    try {
      const orders = await account.getOrders()
      return c.json({ orders })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // Market clock (optional capability)
  app.get('/accounts/:id/market-clock', async (c) => {
    const account = getAccountOrError(c)
    if (account instanceof Response) return account
    if (!account.getMarketClock) return c.json({ error: 'Market clock not supported' }, 501)
    try {
      return c.json(await account.getMarketClock())
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // Quote
  app.get('/accounts/:id/quote/:symbol', async (c) => {
    const account = getAccountOrError(c)
    if (account instanceof Response) return account
    try {
      const symbol = c.req.param('symbol')
      const quote = await account.getQuote({ symbol })
      return c.json(quote)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Per-account trading/git routes ====================

  const getTradingLog = (c: Context) => {
    const git = getTradingGitOrError(c)
    if (git instanceof Response) return git
    const limit = Number(c.req.query('limit')) || 20
    const symbol = c.req.query('symbol') || undefined
    return c.json({ commits: git.log({ limit, symbol }) })
  }

  const getTradingShow = (c: Context) => {
    const git = getTradingGitOrError(c)
    if (git instanceof Response) return git
    const commit = git.show(c.req.param('hash'))
    if (!commit) return c.json({ error: 'Commit not found' }, 404)
    return c.json(commit)
  }

  const getTradingStatus = (c: Context) => {
    const git = getTradingGitOrError(c)
    if (git instanceof Response) return git
    return c.json(git.status())
  }

  const tradingRouteHandlers = [
    ['/accounts/:id/trading/log', getTradingLog],
    ['/accounts/:id/trading/show/:hash', getTradingShow],
    ['/accounts/:id/trading/status', getTradingStatus],
    ['/accounts/:id/wallet/log', getTradingLog],
    ['/accounts/:id/wallet/show/:hash', getTradingShow],
    ['/accounts/:id/wallet/status', getTradingStatus],
  ] as const

  for (const [path, handler] of tradingRouteHandlers) {
    app.get(path, handler)
  }

  return app
}
