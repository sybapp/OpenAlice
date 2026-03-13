import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TraderPage } from './TraderPage'

const { traderApi } = vi.hoisted(() => ({
  traderApi: {
  listStrategies: vi.fn(),
  listJobs: vi.fn(),
    listReviewJobs: vi.fn(),
    getStrategy: vi.fn(),
    runReview: vi.fn(),
  addJob: vi.fn(),
  updateJob: vi.fn(),
  removeJob: vi.fn(),
  runJob: vi.fn(),
  addReviewJob: vi.fn(),
  updateReviewJob: vi.fn(),
  removeReviewJob: vi.fn(),
  runReviewJob: vi.fn(),
  },
}))

const { eventsApi } = vi.hoisted(() => ({
  eventsApi: {
    recent: vi.fn(),
  },
}))

vi.mock('../api', () => ({
  api: {
    trader: traderApi,
    events: eventsApi,
  },
}))

describe('TraderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    traderApi.listStrategies.mockResolvedValue({
      strategies: [{
        id: 'momentum',
        label: 'Momentum',
        enabled: true,
        sources: ['ccxt-main'],
        asset: 'crypto',
        symbols: ['BTC/USDT:USDT'],
      }],
    })
    traderApi.listJobs.mockResolvedValue({
      jobs: [{
        id: 'job-1',
        name: 'Momentum Job',
        enabled: true,
        strategyId: 'momentum',
        schedule: { kind: 'every', every: '1h' },
        state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
        createdAt: Date.now(),
      }],
    })
    traderApi.listReviewJobs.mockResolvedValue({ jobs: [] })
    traderApi.getStrategy.mockResolvedValue({
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      asset: 'crypto',
      symbols: ['BTC/USDT:USDT'],
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: ['trade with trend'], prohibitions: ['no chasing'] },
      executionPolicy: {
        allowedOrderTypes: ['stop', 'stop_limit'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })
    traderApi.runReview.mockResolvedValue({ updated: true, summary: 'review complete', strategyId: undefined })
    traderApi.addReviewJob.mockResolvedValue({ id: 'review-2' })
    eventsApi.recent.mockResolvedValue({
      entries: [{ seq: 1, ts: Date.now(), type: 'trader.done', payload: { reason: 'ok' } }],
      lastSeq: 1,
    })
  })

  it('renders strategies and jobs', async () => {
    render(<TraderPage />)

    expect(await screen.findByText('Momentum')).toBeInTheDocument()
    expect(await screen.findByText('Momentum Job')).toBeInTheDocument()
  })

  it('runs a manual review', async () => {
    render(<TraderPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Global Review' }))

    await waitFor(() => {
      expect(traderApi.runReview).toHaveBeenCalledWith(undefined)
    })
    expect(await screen.findByText('Latest Review Summary')).toBeInTheDocument()
    expect(await screen.findByText(/review complete/)).toBeInTheDocument()
  })

  it('creates a review job from the form', async () => {
    render(<TraderPage />)

    const addButtons = await screen.findAllByRole('button', { name: '+ Add Job' })
    fireEvent.click(addButtons[1])

    fireEvent.change(screen.getByPlaceholderText('Job name'), { target: { value: 'Weekly Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(traderApi.addReviewJob).toHaveBeenCalledWith({
        name: 'Weekly Review',
        strategyId: undefined,
        schedule: { kind: 'every', every: '24h' },
      })
    })
  })

  it('loads and shows strategy details when expanded', async () => {
    render(<TraderPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Show Details' }))

    await waitFor(() => {
      expect(traderApi.getStrategy).toHaveBeenCalledWith('momentum')
    })
    expect(await screen.findByText(/Timeframes: 1h \/ 15m \/ 5m/)).toBeInTheDocument()
    expect(await screen.findByText(/Protection required: yes/)).toBeInTheDocument()
  })

  it('edits a trader job in place', async () => {
    render(<TraderPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Momentum Job' }))

    const nameInput = await screen.findByDisplayValue('Momentum Job')
    fireEvent.change(nameInput, { target: { value: 'Momentum Job v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(traderApi.updateJob).toHaveBeenCalledWith('job-1', {
        name: 'Momentum Job v2',
        strategyId: 'momentum',
        schedule: { kind: 'every', every: '1h' },
      })
    })
  })

  it('runs and deletes trader jobs', async () => {
    render(<TraderPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Momentum Job now' }))
    await waitFor(() => {
      expect(traderApi.runJob).toHaveBeenCalledWith('job-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Momentum Job' }))
    await waitFor(() => {
      expect(traderApi.removeJob).toHaveBeenCalledWith('job-1')
    })
  })

  it('shows an error when manual review fails', async () => {
    traderApi.runReview.mockRejectedValueOnce(new Error('review unavailable'))

    render(<TraderPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Global Review' }))

    expect(await screen.findByText('review unavailable')).toBeInTheDocument()
  })

  it('edits a review job in place', async () => {
    traderApi.listReviewJobs.mockResolvedValue({
      jobs: [{
        id: 'review-1',
        name: 'Weekly Review',
        enabled: true,
        strategyId: undefined,
        schedule: { kind: 'every', every: '24h' },
        state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
        createdAt: Date.now(),
      }],
    })

    render(<TraderPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Weekly Review' }))

    const input = await screen.findByDisplayValue('Weekly Review')
    fireEvent.change(input, { target: { value: 'Weekly Review v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(traderApi.updateReviewJob).toHaveBeenCalledWith('review-1', {
        name: 'Weekly Review v2',
        strategyId: undefined,
        schedule: { kind: 'every', every: '24h' },
      })
    })
  })

  it('validates trader job creation before calling the API', async () => {
    render(<TraderPage />)

    const addButtons = await screen.findAllByRole('button', { name: '+ Add Job' })
    fireEvent.click(addButtons[0])
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Name is required')).toBeInTheDocument()
    expect(traderApi.addJob).not.toHaveBeenCalled()
  })
})
