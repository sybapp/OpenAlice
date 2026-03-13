import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BacktestPage } from './BacktestPage'

const { backtestApi } = vi.hoisted(() => ({
  backtestApi: {
    listRuns: vi.fn(),
    getRun: vi.fn(),
    getSummary: vi.fn(),
    getEquityCurve: vi.fn(),
    getEvents: vi.fn(),
    getGitState: vi.fn(),
    getSessionEntries: vi.fn(),
    fetchBars: vi.fn(),
    startRun: vi.fn(),
  },
}))

vi.mock('../api', () => ({
  api: {
    backtest: backtestApi,
  },
}))

describe('BacktestPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    backtestApi.listRuns.mockResolvedValue({
      runs: [{
        runId: 'run-1',
        status: 'completed',
        mode: 'ai',
        createdAt: '2026-03-13T10:00:00.000Z',
        barCount: 42,
        currentStep: 12,
        accountId: 'paper-account',
        accountLabel: 'Paper Account',
        initialCash: 10_000,
        guards: [],
        artifactDir: '/tmp/run-1',
      }],
    })
    backtestApi.getRun.mockResolvedValue({
      manifest: {
        runId: 'run-1',
        status: 'completed',
        mode: 'ai',
        createdAt: '2026-03-13T10:00:00.000Z',
        barCount: 42,
        currentStep: 12,
        accountId: 'paper-account',
        accountLabel: 'Paper Account',
        initialCash: 10_000,
        guards: [],
        artifactDir: '/tmp/run-1',
      },
    })
    backtestApi.getSummary.mockResolvedValue({
      runId: 'run-1',
      startEquity: 10_000,
      endEquity: 10_550,
      totalReturn: 0.055,
      realizedPnL: 500,
      unrealizedPnL: 50,
      maxDrawdown: 0.02,
      tradeCount: 4,
      winRate: 0.75,
      guardRejectionCount: 1,
    })
    backtestApi.getEquityCurve.mockResolvedValue({
      points: [
        { step: 1, ts: '2026-03-13T10:00:00.000Z', equity: 10_000, realizedPnL: 0, unrealizedPnL: 0 },
        { step: 12, ts: '2026-03-13T10:30:00.000Z', equity: 10_550, realizedPnL: 500, unrealizedPnL: 50 },
      ],
    })
    backtestApi.getEvents.mockResolvedValue({
      entries: [
        { seq: 1, ts: Date.now(), type: 'backtest.started', payload: { step: 1 } },
        { seq: 2, ts: Date.now(), type: 'backtest.trade', payload: { symbol: 'AAPL' } },
      ],
    })
    backtestApi.getGitState.mockResolvedValue({
      head: 'abcd1234',
      commits: [{
        hash: 'abcd1234',
        parentHash: null,
        message: 'Entered long on breakout',
        operations: [{ action: 'placeOrder', params: { symbol: 'AAPL' } }],
        results: [{ action: 'placeOrder', success: true, status: 'filled' }],
        stateAfter: {
          cash: 9_500,
          equity: 10_550,
          unrealizedPnL: 50,
          realizedPnL: 500,
          positions: [],
          pendingOrders: [],
        },
        timestamp: '2026-03-13T10:20:00.000Z',
      }],
    })
    backtestApi.getSessionEntries.mockResolvedValue({
      entries: [{
        type: 'assistant',
        message: { role: 'assistant', content: 'Entered the primary breakout scenario.' },
        uuid: 'entry-1',
        parentUuid: null,
        sessionId: 'run-1',
        timestamp: '2026-03-13T10:20:00.000Z',
      }],
    })
    backtestApi.fetchBars.mockResolvedValue({
      bars: [
        { ts: '2025-01-01T09:30:00.000Z', symbol: 'AAPL', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      ],
    })
    backtestApi.startRun.mockResolvedValue({ runId: 'new-run' })
  })

  it('renders run details and switches across event, git, and session tabs', async () => {
    render(<BacktestPage />)

    expect((await screen.findAllByText('run-1')).length).toBeGreaterThan(0)
    expect(await screen.findByText(/replay on/i)).toBeInTheDocument()
    expect(screen.getByText('Equity Curve')).toBeInTheDocument()
    expect(await screen.findByText('backtest.started')).toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText('Filter by event type'), 'trade')
    expect(screen.getByText('backtest.trade')).toBeInTheDocument()
    expect(screen.queryByText('backtest.started')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Git' }))
    expect(await screen.findByText('Entered long on breakout')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Session' }))
    expect(await screen.findByText('Entered the primary breakout scenario.')).toBeInTheDocument()
  })

  it('creates a new backtest from fetched bars', async () => {
    backtestApi.listRuns
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({
        runs: [{
          runId: 'new-run',
          status: 'queued',
          mode: 'ai',
          createdAt: '2026-03-13T11:00:00.000Z',
          barCount: 1,
          currentStep: 0,
          accountId: 'paper-account',
          accountLabel: 'Paper Account',
          initialCash: 10_000,
          guards: [],
          artifactDir: '/tmp/new-run',
        }],
      })
    backtestApi.getRun.mockResolvedValue({
      manifest: {
        runId: 'new-run',
        status: 'queued',
        mode: 'ai',
        createdAt: '2026-03-13T11:00:00.000Z',
        barCount: 1,
        currentStep: 0,
        accountId: 'paper-account',
        accountLabel: 'Paper Account',
        initialCash: 10_000,
        guards: [],
        artifactDir: '/tmp/new-run',
      },
    })
    backtestApi.getSummary.mockRejectedValue(new Error('not found'))
    backtestApi.getEquityCurve.mockResolvedValue({ points: [] })
    backtestApi.getEvents.mockResolvedValue({ entries: [] })
    backtestApi.getGitState.mockRejectedValue(new Error('not found'))
    backtestApi.getSessionEntries.mockResolvedValue({ entries: [] })

    render(<BacktestPage />)

    const newBacktestButtons = await screen.findAllByRole('button', { name: 'New Backtest' })
    await userEvent.click(newBacktestButtons[0])
    expect(await screen.findByRole('button', { name: 'Start Backtest' })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Run ID (optional)'), 'bt-sample')
    fireEvent.change(screen.getByLabelText('Initial Cash'), { target: { value: '15000' } })
    await userEvent.click(screen.getByRole('button', { name: 'Fetch Bars' }))

    await waitFor(() => {
      expect(backtestApi.fetchBars).toHaveBeenCalledWith({
        assetType: 'equity',
        symbol: 'AAPL',
        startDate: '2025-01-01',
        endDate: '2025-01-31',
      })
    })

    await userEvent.click(screen.getByRole('button', { name: 'Start Backtest' }))

    await waitFor(() => {
      expect(backtestApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'bt-sample',
        initialCash: 15000,
        bars: [{
          ts: '2025-01-01T09:30:00.000Z',
          symbol: 'AAPL',
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000,
        }],
        strategy: expect.objectContaining({
          mode: 'ai',
        }),
      }))
    })
    expect((await screen.findAllByText('new-run')).length).toBeGreaterThan(0)
  })
})
