import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readPlatformsConfig: vi.fn(),
  writePlatformsConfig: vi.fn(),
  readAccountsConfig: vi.fn(),
  writeAccountsConfig: vi.fn(),
}))

vi.mock('../../../core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/config.js')>('../../../core/config.js')
  return {
    ...actual,
    readPlatformsConfig: mocks.readPlatformsConfig,
    writePlatformsConfig: mocks.writePlatformsConfig,
    readAccountsConfig: mocks.readAccountsConfig,
    writeAccountsConfig: mocks.writeAccountsConfig,
  }
})

const { createTradingConfigRoutes } = await import('./trading-config.js')

const platforms = [
  {
    id: 'binance-platform',
    type: 'ccxt' as const,
    exchange: 'binance',
    sandbox: false,
    demoTrading: false,
    defaultMarketType: 'swap' as const,
  },
]

describe('createTradingConfigRoutes', () => {
  let storedAccounts: Array<{
    id: string
    platformId: string
    label?: string
    apiKey?: string
    apiSecret?: string
    password?: string
    guards: Array<{ type: string; options: Record<string, unknown> }>
  }>

  beforeEach(() => {
    storedAccounts = [
      {
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Binance Main',
        apiKey: 'api-key-secret',
        apiSecret: 'api-secret-secret',
        password: 'password-secret',
        guards: [],
      },
    ]

    mocks.readPlatformsConfig.mockReset()
    mocks.writePlatformsConfig.mockReset()
    mocks.readAccountsConfig.mockReset()
    mocks.writeAccountsConfig.mockReset()

    mocks.readPlatformsConfig.mockImplementation(async () => platforms)
    mocks.readAccountsConfig.mockImplementation(async () => storedAccounts)
    mocks.writeAccountsConfig.mockImplementation(async (accounts) => {
      storedAccounts = accounts
    })
  })

  it('returns trading accounts without exposing stored credentials', async () => {
    const app = createTradingConfigRoutes({
      accountManager: { has: vi.fn().mockReturnValue(false) },
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
    } as never)

    const res = await app.request('/')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.accounts).toEqual([
      {
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Binance Main',
        hasApiKey: true,
        hasApiSecret: true,
        hasPassword: true,
        guards: [],
      },
    ])
    expect(body.accounts[0].apiKey).toBeUndefined()
    expect(body.accounts[0].apiSecret).toBeUndefined()
    expect(body.accounts[0].password).toBeUndefined()
  })

  it('preserves existing credentials when a save omits secret fields', async () => {
    const app = createTradingConfigRoutes({
      accountManager: { has: vi.fn().mockReturnValue(false) },
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
    } as never)

    const res = await app.request('/accounts/binance-main', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Renamed Account',
        guards: [{ type: 'max-order-notional', options: { max: 1000 } }],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storedAccounts).toEqual([
      {
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Renamed Account',
        apiKey: 'api-key-secret',
        apiSecret: 'api-secret-secret',
        password: 'password-secret',
        guards: [{ type: 'max-order-notional', options: { max: 1000 } }],
      },
    ])
    expect(body).toEqual({
      id: 'binance-main',
      platformId: 'binance-platform',
      label: 'Renamed Account',
      hasApiKey: true,
      hasApiSecret: true,
      hasPassword: true,
      guards: [{ type: 'max-order-notional', options: { max: 1000 } }],
    })
  })

  it('clears selected credentials when they are explicitly set to null', async () => {
    const reconnectAccount = vi.fn().mockResolvedValue({ success: true, message: 'Reconnected' })
    const app = createTradingConfigRoutes({
      accountManager: { has: vi.fn().mockReturnValue(true) },
      reconnectAccount,
      removeTradingAccountRuntime: vi.fn(),
    } as never)

    const res = await app.request('/accounts/binance-main', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'binance-main',
        platformId: 'binance-platform',
        guards: [],
        apiSecret: null,
        password: null,
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storedAccounts).toEqual([
      {
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Binance Main',
        apiKey: 'api-key-secret',
        guards: [],
      },
    ])
    expect(body).toEqual({
      id: 'binance-main',
      platformId: 'binance-platform',
      label: 'Binance Main',
      hasApiKey: true,
      hasApiSecret: false,
      hasPassword: false,
      guards: [],
      reconnect: { success: true, message: 'Reconnected' },
    })
    expect(reconnectAccount).toHaveBeenCalledWith('binance-main')
  })

  it('rejects account saves that reference an unknown platform', async () => {
    const app = createTradingConfigRoutes({
      accountManager: { has: vi.fn().mockReturnValue(false) },
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
    } as never)

    const res = await app.request('/accounts/binance-main', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'binance-main',
        platformId: 'missing-platform',
        guards: [],
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Platform "missing-platform" not found' })
  })

  it('reconnects affected running accounts when a platform is updated', async () => {
    const reconnectAccount = vi.fn(async (id: string) => ({ success: true, message: `reconnected ${id}` }))
    storedAccounts.push({
      id: 'binance-alt',
      platformId: 'binance-platform',
      label: 'Binance Alt',
      guards: [],
    })

    const app = createTradingConfigRoutes({
      accountManager: { has: vi.fn((id: string) => id !== 'binance-alt') },
      reconnectAccount,
      removeTradingAccountRuntime: vi.fn(),
    } as never)

    const res = await app.request('/platforms/binance-platform', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'binance-platform',
        type: 'ccxt',
        exchange: 'binance',
        sandbox: true,
        demoTrading: false,
        defaultMarketType: 'swap',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(reconnectAccount).toHaveBeenCalledWith('binance-main')
    expect(body.reconnected).toEqual([
      { id: 'binance-main', success: true, message: 'reconnected binance-main' },
    ])
  })

  it('removes live runtime state when deleting a connected account', async () => {
    const removeTradingAccountRuntime = vi.fn(async () => undefined)
    const app = createTradingConfigRoutes({
      accountManager: { has: vi.fn().mockReturnValue(true) },
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime,
    } as never)

    const res = await app.request('/accounts/binance-main', {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect(removeTradingAccountRuntime).toHaveBeenCalledWith('binance-main')
    expect(storedAccounts).toEqual([])
  })
})
