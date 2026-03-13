import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PortfolioPage } from './PortfolioPage'

const { tradingApi } = vi.hoisted(() => ({
  tradingApi: {
    equity: vi.fn(),
    listAccounts: vi.fn(),
    positions: vi.fn(),
    tradingLog: vi.fn(),
  },
}))

vi.mock('../api', () => ({
  api: {
    trading: tradingApi,
  },
}))

describe('PortfolioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders aggregated metrics, positions, and recent trades across accounts', async () => {
    tradingApi.equity.mockResolvedValue({
      totalEquity: 12_000,
      totalCash: 4_500,
      totalUnrealizedPnL: 120,
      totalRealizedPnL: 75,
      accounts: [
        { id: 'ccxt-main', label: 'Main Crypto', equity: 8_000, cash: 2_500 },
        { id: 'alpaca-paper', label: 'Paper Equity', equity: 4_000, cash: 2_000 },
      ],
    })
    tradingApi.listAccounts.mockResolvedValue({
      accounts: [
        { id: 'ccxt-main', label: 'Main Crypto', provider: 'ccxt' },
        { id: 'alpaca-paper', label: 'Paper Equity', provider: 'alpaca' },
      ],
    })
    tradingApi.positions.mockImplementation(async (accountId: string) => {
      if (accountId === 'ccxt-main') {
        return {
          positions: [{
            contract: { symbol: 'BTC/USDT:USDT' },
            side: 'long',
            qty: 1,
            avgEntryPrice: 99_000,
            currentPrice: 100_000,
            marketValue: 100_000,
            unrealizedPnL: 1_000,
            unrealizedPnLPercent: 1.01,
            costBasis: 99_000,
            leverage: 2,
          }],
        }
      }
      return { positions: [] }
    })
    tradingApi.tradingLog.mockImplementation(async (accountId: string) => ({
      commits: accountId === 'ccxt-main'
        ? [{
            hash: 'abcd1234',
            message: 'Breakout continuation long',
            operations: [{ symbol: 'BTC/USDT:USDT', action: 'placeOrder', change: '+1', status: 'filled' }],
            timestamp: '2026-03-13T10:00:00.000Z',
          }]
        : [],
    }))

    render(<PortfolioPage />)

    expect(await screen.findByText('Portfolio')).toBeInTheDocument()
    expect(await screen.findByText('$12,000.00')).toBeInTheDocument()
    expect(screen.getByText('BTC/USDT:USDT')).toBeInTheDocument()
    expect(screen.getAllByText('Main Crypto').length).toBeGreaterThan(0)
    expect(screen.getByText('Breakout continuation long')).toBeInTheDocument()
    expect(screen.getByText('Recent Trades')).toBeInTheDocument()
  })

  it('shows empty and recovery states when accounts are missing or disconnected', async () => {
    tradingApi.equity
      .mockResolvedValueOnce({
        totalEquity: 0,
        totalCash: 0,
        totalUnrealizedPnL: 0,
        totalRealizedPnL: 0,
        accounts: [],
      })
      .mockResolvedValueOnce({
        totalEquity: 2_000,
        totalCash: 500,
        totalUnrealizedPnL: 0,
        totalRealizedPnL: 0,
        accounts: [{ id: 'ccxt-main', label: 'Main Crypto', equity: 2_000, cash: 500 }],
      })
    tradingApi.listAccounts
      .mockResolvedValueOnce({ accounts: [] })
      .mockResolvedValueOnce({ accounts: [{ id: 'ccxt-main', label: 'Main Crypto', provider: 'ccxt' }] })
    tradingApi.positions.mockRejectedValue(new Error('offline'))
    tradingApi.tradingLog.mockRejectedValue(new Error('offline'))

    render(<PortfolioPage />)

    expect(await screen.findByText('No trading accounts connected.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => {
      expect(screen.getByText('Not connected')).toBeInTheDocument()
    })
    expect(screen.getByText('No open positions.')).toBeInTheDocument()
  })
})
