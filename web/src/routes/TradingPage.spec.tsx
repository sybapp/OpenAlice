import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformConfig, TradingConfigAccount, UpdateTradingAccountRequest } from '../api/types'
import { TradingPage } from './TradingPage'

const mocks = vi.hoisted(() => ({
  savePlatform: vi.fn().mockResolvedValue(undefined),
  deletePlatform: vi.fn().mockResolvedValue(undefined),
  saveAccountSpy: vi.fn(),
  deleteAccount: vi.fn().mockResolvedValue(undefined),
  reconnectAccount: vi.fn().mockResolvedValue({ success: true, message: 'Connected' }),
  refresh: vi.fn().mockResolvedValue(undefined),
}))

let platformFixtures: PlatformConfig[] = []
let accountFixtures: TradingConfigAccount[] = []

vi.mock('../hooks/useTradingConfig', async () => {
  const React = await import('react')

  return {
    useTradingConfig: () => {
      const [accounts, setAccounts] = React.useState(accountFixtures)

      const saveAccount = async (input: UpdateTradingAccountRequest) => {
        mocks.saveAccountSpy(input)
        const current = accounts.find((account) => account.id === input.id)
        if (!current) throw new Error(`Unknown account: ${input.id}`)

        const saved: TradingConfigAccount = {
          ...current,
          platformId: input.platformId,
          label: input.label,
          guards: input.guards,
          hasApiKey: input.apiKey === undefined ? current.hasApiKey : input.apiKey !== null,
          hasApiSecret: input.apiSecret === undefined ? current.hasApiSecret : input.apiSecret !== null,
          hasPassword: input.password === undefined ? current.hasPassword : input.password !== null,
        }

        setAccounts((prev) => prev.map((account) => (account.id === saved.id ? saved : account)))
        return saved
      }

      return {
        platforms: platformFixtures,
        accounts,
        loading: false,
        error: null,
        savePlatform: mocks.savePlatform,
        deletePlatform: mocks.deletePlatform,
        saveAccount,
        deleteAccount: mocks.deleteAccount,
        reconnectAccount: mocks.reconnectAccount,
        refresh: mocks.refresh,
      }
    },
  }
})

describe('TradingPage', () => {
  beforeEach(() => {
    platformFixtures = [
      {
        id: 'binance-platform',
        type: 'ccxt',
        exchange: 'binance',
        sandbox: false,
        demoTrading: false,
        defaultMarketType: 'swap',
      },
    ]
    accountFixtures = [
      {
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Binance Main',
        hasApiKey: false,
        hasApiSecret: true,
        hasPassword: true,
        guards: [],
      },
    ]

    mocks.savePlatform.mockClear()
    mocks.deletePlatform.mockClear()
    mocks.saveAccountSpy.mockClear()
    mocks.deleteAccount.mockClear()
    mocks.reconnectAccount.mockClear()
    mocks.refresh.mockClear()
  })

  it('does not reveal stored trading secrets and supports explicit set/clear actions', async () => {
    render(<TradingPage />)

    await userEvent.click(screen.getByText('binance-main'))

    expect(screen.getByLabelText('Trading API Key')).toHaveValue('')
    expect(screen.getByLabelText('Trading API Secret')).toHaveValue('')
    expect(screen.getByLabelText('Trading Password')).toHaveValue('')
    expect(screen.getByText('Not configured')).toBeInTheDocument()
    expect(screen.getAllByText('Configured')).toHaveLength(2)

    await userEvent.type(screen.getByLabelText('Trading API Key'), 'rotated-key')
    await userEvent.click(screen.getByLabelText('Set Trading API Key'))

    await waitFor(() =>
      expect(mocks.saveAccountSpy).toHaveBeenCalledWith({
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Binance Main',
        guards: [],
        apiKey: 'rotated-key',
      }),
    )

    expect(screen.getByLabelText('Trading API Key')).toHaveValue('')

    await userEvent.click(screen.getByLabelText('Clear Trading API Secret'))

    await waitFor(() =>
      expect(mocks.saveAccountSpy).toHaveBeenCalledWith({
        id: 'binance-main',
        platformId: 'binance-platform',
        label: 'Binance Main',
        guards: [],
        apiSecret: null,
      }),
    )
  })
})
