import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadTradingConfig: vi.fn(),
  createPlatformFromConfig: vi.fn(),
}))

vi.mock('../core/config.js', () => ({
  loadTradingConfig: mocks.loadTradingConfig,
}))

vi.mock('../domains/trading/index.js', async () => {
  const actual = await vi.importActual<typeof import('../domains/trading/index.js')>('../domains/trading/index.js')
  return {
    ...actual,
    createPlatformFromConfig: mocks.createPlatformFromConfig,
  }
})

const {
  teardownAccountRuntime,
  createAccountReconnector,
} = await import('./trading-accounts.js')

describe('teardownAccountRuntime', () => {
  it('disposes the dispatcher, closes the account, and removes runtime state', async () => {
    const close = vi.fn(async () => undefined)
    const removeAccount = vi.fn()
    const disposeDispatcher = vi.fn()
    const accountManager = {
      getAccount: vi.fn(() => ({ close })),
      removeAccount,
    }
    const accountSetups = new Map([
      ['paper-1', { disposeDispatcher }],
    ])

    await teardownAccountRuntime({
      accountId: 'paper-1',
      accountManager: accountManager as never,
      accountSetups: accountSetups as never,
    })

    expect(disposeDispatcher).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    expect(removeAccount).toHaveBeenCalledWith('paper-1')
    expect(accountSetups.has('paper-1')).toBe(false)
  })

  it('removes stale setup state even when no live account is present', async () => {
    const removeAccount = vi.fn()
    const disposeDispatcher = vi.fn()
    const accountSetups = new Map([
      ['paper-2', { disposeDispatcher }],
    ])

    await teardownAccountRuntime({
      accountId: 'paper-2',
      accountManager: {
        getAccount: vi.fn(() => undefined),
        removeAccount,
      } as never,
      accountSetups: accountSetups as never,
    })

    expect(disposeDispatcher).toHaveBeenCalled()
    expect(removeAccount).toHaveBeenCalledWith('paper-2')
    expect(accountSetups.has('paper-2')).toBe(false)
  })

  it('continues teardown and surfaces aggregated cleanup errors', async () => {
    const close = vi.fn(async () => {
      throw new Error('socket hung')
    })
    const removeAccount = vi.fn()
    const disposeDispatcher = vi.fn(() => {
      throw new Error('watcher persist failed')
    })
    const accountSetups = new Map([
      ['paper-3', { disposeDispatcher }],
    ])

    await expect(teardownAccountRuntime({
      accountId: 'paper-3',
      accountManager: {
        getAccount: vi.fn(() => ({ close })),
        removeAccount,
      } as never,
      accountSetups: accountSetups as never,
    })).rejects.toThrow('dispatcher dispose failed: watcher persist failed; account close failed: socket hung')

    expect(disposeDispatcher).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(removeAccount).toHaveBeenCalledWith('paper-3')
    expect(accountSetups.has('paper-3')).toBe(false)
  })
})

describe('createAccountReconnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects overlapping reconnects for the same account', async () => {
    let resolveConfig: ((value: unknown) => void) | undefined
    mocks.loadTradingConfig.mockImplementation(() => new Promise((resolve) => {
      resolveConfig = resolve
    }))

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(),
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      prepareAccountRuntime: vi.fn(),
    })

    const pending = reconnect('paper-1')
    await expect(reconnect('paper-1')).resolves.toEqual({
      success: false,
      error: 'Reconnect already in progress',
    })

    resolveConfig?.({ accounts: [], platforms: [] })
    await expect(pending).resolves.toEqual({
      success: true,
      message: 'Account "paper-1" not found in config (removed or disabled)',
    })
  })

  it('returns an error when the referenced platform no longer exists', async () => {
    mocks.loadTradingConfig.mockResolvedValue({
      accounts: [{ id: 'paper-1', platformId: 'missing-platform', guards: [] }],
      platforms: [],
    })
    const close = vi.fn(async () => undefined)
    const removeAccount = vi.fn()

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(() => ({ close })),
        removeAccount,
      } as never,
      accountSetups: new Map(),
      prepareAccountRuntime: vi.fn(),
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: false,
      error: 'Platform "missing-platform" not found for account "paper-1"',
    })
    expect(close).not.toHaveBeenCalled()
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('tears down runtime only after the account is removed or disabled', async () => {
    mocks.loadTradingConfig.mockResolvedValue({
      accounts: [],
      platforms: [],
    })
    const close = vi.fn(async () => undefined)
    const removeAccount = vi.fn()

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(() => ({ close })),
        removeAccount,
      } as never,
      accountSetups: new Map(),
      prepareAccountRuntime: vi.fn(),
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: true,
      message: 'Account "paper-1" not found in config (removed or disabled)',
    })
    expect(close).toHaveBeenCalledOnce()
    expect(removeAccount).toHaveBeenCalledWith('paper-1')
  })

  it('reconnects a ccxt account', async () => {
    const prepareAccountRuntime = vi.fn(async () => ({
      account: { id: 'paper-1', label: 'Main Binance' },
      setup: { disposeDispatcher: vi.fn() },
    }))
    const getAccount = vi.fn()
      .mockReturnValueOnce({ close: vi.fn(async () => undefined) })
      .mockReturnValue({ label: 'Main Binance' })
    mocks.loadTradingConfig.mockResolvedValue({
      accounts: [{ id: 'paper-1', platformId: 'binance', guards: [] }],
      platforms: [{ id: 'binance', type: 'ccxt', exchange: 'binance' }],
    })
    mocks.createPlatformFromConfig.mockReturnValue({
      id: 'binance',
      providerType: 'ccxt',
    })

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount,
        addAccount: vi.fn(),
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      prepareAccountRuntime,
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: true,
      message: 'Main Binance reconnected',
    })
    expect(prepareAccountRuntime).toHaveBeenCalledWith(
      { id: 'paper-1', platformId: 'binance', guards: [] },
      { id: 'binance', providerType: 'ccxt' },
    )
  })

  it('returns an init-failed error when the recreated account cannot initialize', async () => {
    mocks.loadTradingConfig.mockResolvedValue({
      accounts: [{ id: 'paper-1', platformId: 'binance-main', guards: [] }],
      platforms: [{ id: 'binance-main', type: 'ccxt', exchange: 'binance' }],
    })
    mocks.createPlatformFromConfig.mockReturnValue({
      id: 'binance-main',
      providerType: 'ccxt',
    })

    const close = vi.fn(async () => undefined)
    const removeAccount = vi.fn()
    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(() => ({ close })),
        removeAccount,
      } as never,
      accountSetups: new Map(),
      prepareAccountRuntime: vi.fn(async () => null),
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: false,
      error: 'Account "paper-1" init failed',
    })
    expect(close).not.toHaveBeenCalled()
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('surfaces unexpected reconnect errors', async () => {
    mocks.loadTradingConfig.mockRejectedValue(new Error('disk unavailable'))

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(),
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      prepareAccountRuntime: vi.fn(),
    })

    await expect(reconnect('paper-9')).resolves.toEqual({
      success: false,
      error: 'disk unavailable',
    })
  })
})
