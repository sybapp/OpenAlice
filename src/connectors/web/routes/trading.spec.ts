import { describe, expect, it, vi } from 'vitest'
import { createTradingRoutes } from './trading.js'

describe('createTradingRoutes', () => {
  it('returns a 500 when reconnecting an account fails', async () => {
    const app = createTradingRoutes({
      reconnectAccount: vi.fn(async () => ({ success: false, error: 'offline' })),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(),
      },
      getAccountGit: vi.fn(),
    } as never)

    const res = await app.request('/accounts/paper-1/reconnect', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'offline' })
  })

  it('returns 501 when a trading account does not expose market clock support', async () => {
    const app = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(() => ({
          getAccount: vi.fn(),
          getPositions: vi.fn(),
          getOrders: vi.fn(),
          getQuote: vi.fn(),
        })),
      },
      getAccountGit: vi.fn(),
    } as never)

    const res = await app.request('/accounts/paper-1/market-clock')
    expect(res.status).toBe(501)
    expect(await res.json()).toEqual({ error: 'Market clock not supported' })
  })

  it('serves trading log and wallet log aliases from the same git history', async () => {
    const log = vi.fn(() => [{ hash: 'abcd1234', message: 'Breakout long' }])
    const show = vi.fn((hash: string) => (hash === 'abcd1234' ? { hash, message: 'Breakout long' } : null))
    const status = vi.fn(() => ({ head: 'abcd1234', staged: 1 }))
    const app = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(),
      },
      getAccountGit: vi.fn(() => ({ log, show, status })),
    } as never)

    const [tradingLog, walletLog, tradingShow, walletStatus] = await Promise.all([
      app.request('/accounts/paper-1/trading/log?limit=5'),
      app.request('/accounts/paper-1/wallet/log?limit=5'),
      app.request('/accounts/paper-1/trading/show/abcd1234'),
      app.request('/accounts/paper-1/wallet/status'),
    ])

    expect(await tradingLog.json()).toEqual(await walletLog.json())
    expect(await tradingShow.json()).toEqual({ hash: 'abcd1234', message: 'Breakout long' })
    expect(await walletStatus.json()).toEqual({ head: 'abcd1234', staged: 1 })
    expect(log).toHaveBeenCalledWith({ limit: 5, symbol: undefined })
  })

  it('returns 404 when trading history is missing or a commit cannot be found', async () => {
    const missingGitApp = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(),
      },
      getAccountGit: vi.fn(() => undefined),
    } as never)

    const noGit = await missingGitApp.request('/accounts/paper-1/trading/status')
    expect(noGit.status).toBe(404)
    expect(await noGit.json()).toEqual({ error: 'Account or trading history not found' })

    const missingCommitApp = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(),
      },
      getAccountGit: vi.fn(() => ({
        log: vi.fn(),
        show: vi.fn(() => null),
        status: vi.fn(),
      })),
    } as never)

    const noCommit = await missingCommitApp.request('/accounts/paper-1/trading/show/deadbeef')
    expect(noCommit.status).toBe(404)
    expect(await noCommit.json()).toEqual({ error: 'Commit not found' })
  })

  it('returns 404 when the account does not exist for account-scoped routes', async () => {
    const app = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(() => undefined),
      },
      getAccountGit: vi.fn(),
    } as never)

    const [accountRes, positionsRes, quoteRes] = await Promise.all([
      app.request('/accounts/missing/account'),
      app.request('/accounts/missing/positions'),
      app.request('/accounts/missing/quote/BTCUSDT'),
    ])

    expect(accountRes.status).toBe(404)
    expect(positionsRes.status).toBe(404)
    expect(quoteRes.status).toBe(404)
    expect(await accountRes.json()).toEqual({ error: 'Account not found' })
  })

  it('returns 500 when an account-scoped operation throws', async () => {
    const app = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(() => ({
          getAccount: vi.fn(async () => {
            throw new Error('account offline')
          }),
          getPositions: vi.fn(async () => {
            throw new Error('positions unavailable')
          }),
          getOrders: vi.fn(),
          getQuote: vi.fn(async () => ({ symbol: 'BTCUSDT', bid: 1 })),
          getMarketClock: vi.fn(async () => ({ is_open: true })),
        })),
      },
      getAccountGit: vi.fn(),
    } as never)

    const accountRes = await app.request('/accounts/paper-1/account')
    const positionsRes = await app.request('/accounts/paper-1/positions')

    expect(accountRes.status).toBe(500)
    expect(await accountRes.json()).toEqual({ error: 'Error: account offline' })
    expect(positionsRes.status).toBe(500)
    expect(await positionsRes.json()).toEqual({ error: 'Error: positions unavailable' })
  })

  it('returns quotes and market clock data when supported', async () => {
    const getQuote = vi.fn(async ({ symbol }: { symbol: string }) => ({ symbol, bid: 101, ask: 102 }))
    const getMarketClock = vi.fn(async () => ({ is_open: true }))
    const app = createTradingRoutes({
      reconnectAccount: vi.fn(),
      accountManager: {
        listAccounts: vi.fn(() => []),
        getAggregatedEquity: vi.fn(),
        getAccount: vi.fn(() => ({
          getAccount: vi.fn(),
          getPositions: vi.fn(),
          getOrders: vi.fn(),
          getQuote,
          getMarketClock,
        })),
      },
      getAccountGit: vi.fn(),
    } as never)

    const quoteRes = await app.request('/accounts/paper-1/quote/AAPL')
    const clockRes = await app.request('/accounts/paper-1/market-clock')

    expect(await quoteRes.json()).toEqual({ symbol: 'AAPL', bid: 101, ask: 102 })
    expect(await clockRes.json()).toEqual({ is_open: true })
    expect(getQuote).toHaveBeenCalledWith({ symbol: 'AAPL' })
  })
})
