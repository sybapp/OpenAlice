import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadTradingConfig: vi.fn(),
  createPlatformFromConfig: vi.fn(),
  createCcxtProviderTools: vi.fn(() => ['ccxt-tool']),
}))

vi.mock('../core/config.js', () => ({
  loadTradingConfig: mocks.loadTradingConfig,
}))

vi.mock('../extension/trading/index.js', async () => {
  const actual = await vi.importActual<typeof import('../extension/trading/index.js')>('../extension/trading/index.js')
  return {
    ...actual,
    createPlatformFromConfig: mocks.createPlatformFromConfig,
    createCcxtProviderTools: mocks.createCcxtProviderTools,
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
      initAccount: vi.fn(),
      toolCenter: { register: vi.fn() } as never,
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

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(),
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      initAccount: vi.fn(),
      toolCenter: { register: vi.fn() } as never,
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: false,
      error: 'Platform "missing-platform" not found for account "paper-1"',
    })
  })

  it('re-registers CCXT tools after a successful non-alpaca reconnect', async () => {
    const initAccount = vi.fn(async () => true)
    const register = vi.fn()
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
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      initAccount,
      toolCenter: { register } as never,
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: true,
      message: 'Main Binance reconnected',
    })
    expect(initAccount).toHaveBeenCalledWith(
      { id: 'paper-1', platformId: 'binance', guards: [] },
      { id: 'binance', providerType: 'ccxt' },
    )
    expect(mocks.createCcxtProviderTools).toHaveBeenCalled()
    expect(register).toHaveBeenCalledWith(['ccxt-tool'], 'trading-ccxt')
  })

  it('returns an init-failed error when the recreated account cannot initialize', async () => {
    mocks.loadTradingConfig.mockResolvedValue({
      accounts: [{ id: 'paper-1', platformId: 'alpaca-main', guards: [] }],
      platforms: [{ id: 'alpaca-main', type: 'alpaca', paper: true }],
    })
    mocks.createPlatformFromConfig.mockReturnValue({
      id: 'alpaca-main',
      providerType: 'alpaca',
    })

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      initAccount: vi.fn(async () => false),
      toolCenter: { register: vi.fn() } as never,
    })

    await expect(reconnect('paper-1')).resolves.toEqual({
      success: false,
      error: 'Account "paper-1" init failed',
    })
  })

  it('surfaces unexpected reconnect errors', async () => {
    mocks.loadTradingConfig.mockRejectedValue(new Error('disk unavailable'))

    const reconnect = createAccountReconnector({
      accountManager: {
        getAccount: vi.fn(),
        removeAccount: vi.fn(),
      } as never,
      accountSetups: new Map(),
      initAccount: vi.fn(),
      toolCenter: { register: vi.fn() } as never,
    })

    await expect(reconnect('paper-9')).resolves.toEqual({
      success: false,
      error: 'disk unavailable',
    })
  })
})
