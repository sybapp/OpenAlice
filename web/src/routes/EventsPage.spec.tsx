import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventsPage } from './EventsPage'

const mocks = vi.hoisted(() => ({
  api: {
    events: {
      query: vi.fn(),
    },
    cron: {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      runNow: vi.fn(),
      remove: vi.fn(),
    },
  },
  useSSE: vi.fn(),
}))

vi.mock('../api', () => ({
  api: mocks.api,
}))

vi.mock('../hooks/useSSE', () => ({
  useSSE: mocks.useSSE,
}))

describe('EventsPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/events')
    vi.clearAllMocks()
    mocks.api.events.query.mockResolvedValue({
      entries: [
        { seq: 2, ts: Date.now(), type: 'cron.fire', payload: { job: 'review' } },
        { seq: 1, ts: Date.now() - 1_000, type: 'heartbeat.tick', payload: { ok: true } },
      ],
      page: 1,
      pageSize: 100,
      total: 2,
      totalPages: 1,
    })
    mocks.api.cron.list.mockResolvedValue({
      jobs: [
        {
          id: 'job-1',
          name: 'Morning Review',
          enabled: true,
          schedule: { kind: 'every', every: '1h' },
          payload: 'review market structure',
          createdAt: Date.now() - 60_000,
          state: {
            nextRunAtMs: Date.now() + 3_600_000,
            lastRunAtMs: null,
            lastStatus: null,
            consecutiveErrors: 0,
          },
        },
      ],
    })
    mocks.api.cron.add.mockResolvedValue({ id: 'job-2' })
    mocks.api.cron.update.mockResolvedValue(undefined)
    mocks.api.cron.runNow.mockResolvedValue(undefined)
    mocks.api.cron.remove.mockResolvedValue(undefined)
  })

  it('renders the event log, prepends SSE updates, and can pause the stream', async () => {
    let lastSSEConfig: { onMessage: (entry: any) => void } | undefined
    mocks.useSSE.mockImplementation((config) => {
      lastSSEConfig = config
    })

    render(<EventsPage />)

    expect(await screen.findByText('cron.fire')).toBeInTheDocument()
    expect(screen.getAllByText('heartbeat.tick').length).toBeGreaterThan(0)
    expect(mocks.api.events.query).toHaveBeenCalledWith({
      page: 1,
      pageSize: 100,
      type: undefined,
    })

    act(() => {
      lastSSEConfig?.onMessage({
        seq: 3,
        ts: Date.now(),
        type: 'trader.done',
        payload: {
          strategyId: 'momentum',
          reason: 'Execution confirmed.',
          decision: {
            source: 'Paper Alpha',
            symbol: 'BTC/USDT:USDT',
          },
        },
      })
    })

    expect((await screen.findAllByText('trader.done')).length).toBeGreaterThan(0)
    expect(await screen.findByText(/momentum — Paper Alpha • BTC\/USDT:USDT — Execution confirmed\./)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /pause/i }))

    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument()
    expect(mocks.useSSE).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    )
  })

  it('renders trader event detail cards with status-specific labels', async () => {
    mocks.api.events.query.mockResolvedValueOnce({
      entries: [
        {
          seq: 3,
          ts: Date.now(),
          type: 'trader.error',
          payload: {
            strategyId: 'breakout',
            jobName: 'Asia open',
            error: 'Order rejected by risk controls.',
            channel: 'scheduled',
            decision: {
              source: 'Paper Alpha',
              symbol: 'ETH/USDT:USDT',
              chosenScenario: 'short-continuation',
              actionsTaken: ['Cancel pending order', 'Reduce size to 0.25R'],
              invalidation: ['If 15m closes above prior swing high'],
            },
          },
        },
        {
          seq: 2,
          ts: Date.now() - 1_000,
          type: 'trader.skip',
          payload: {
            strategyId: 'mean-revert',
            reason: 'No clean setup on the watchlist.',
            decision: {
              source: 'Paper Beta',
              symbol: 'BTC/USDT:USDT',
            },
          },
        },
      ],
      page: 1,
      pageSize: 100,
      total: 2,
      totalPages: 1,
    })

    render(<EventsPage />)

    expect((await screen.findAllByText('trader.error')).length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByText('trader.error')[1]!)

    expect(await screen.findByText('Raw Payload')).toBeInTheDocument()
    expect(screen.getAllByText('Error').length).toBeGreaterThan(0)
    expect(screen.getByText('Source: Paper Alpha')).toBeInTheDocument()
    expect(screen.getByText('Symbol: ETH/USDT:USDT')).toBeInTheDocument()
    expect(screen.getByText('Scenario: short-continuation')).toBeInTheDocument()
    expect(screen.getByText('Channel: scheduled')).toBeInTheDocument()
    expect(screen.getByText('Cancel pending order')).toBeInTheDocument()
    expect(screen.getByText('If 15m closes above prior swing high')).toBeInTheDocument()

    await userEvent.click(screen.getAllByText('trader.skip')[1]!)

    expect((await screen.findAllByText('Skipped')).length).toBeGreaterThan(0)
    expect(screen.getByText('Source: Paper Beta')).toBeInTheDocument()
    expect(screen.getAllByText('No clean setup on the watchlist.').length).toBeGreaterThan(0)
  })

  it('filters the current page with trader quick filters', async () => {
    mocks.api.events.query.mockResolvedValueOnce({
      entries: [
        {
          seq: 4,
          ts: Date.now(),
          type: 'trader.done',
          payload: {
            strategyId: 'momentum',
            reason: 'Execution confirmed.',
          },
        },
        {
          seq: 3,
          ts: Date.now() - 1_000,
          type: 'trader.error',
          payload: {
            strategyId: 'breakout',
            error: 'Risk controls rejected the trade.',
          },
        },
        {
          seq: 2,
          ts: Date.now() - 2_000,
          type: 'trader.review.done',
          payload: {
            strategyId: 'review-asia',
            summary: 'Watchlist refreshed.',
          },
        },
        {
          seq: 1,
          ts: Date.now() - 3_000,
          type: 'cron.fire',
          payload: { job: 'heartbeat' },
        },
      ],
      page: 1,
      pageSize: 100,
      total: 4,
      totalPages: 1,
    })

    render(<EventsPage />)
    await screen.findAllByText('trader.done')
    const tbody = () => document.querySelector('tbody') as HTMLElement

    expect(within(tbody()).getByText('trader.done')).toBeInTheDocument()
    expect(within(tbody()).getByText('trader.error')).toBeInTheDocument()
    expect(within(tbody()).getByText('trader.review.done')).toBeInTheDocument()
    expect(within(tbody()).getByText('cron.fire')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Error' }))

    expect(await screen.findByText(/1 shown/)).toBeInTheDocument()
    expect(within(tbody()).getByText('trader.error')).toBeInTheDocument()
    expect(within(tbody()).queryByText('trader.done')).not.toBeInTheDocument()
    expect(within(tbody()).queryByText('trader.review.done')).not.toBeInTheDocument()
    expect(within(tbody()).queryByText('cron.fire')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(await within(tbody()).findByText('trader.review.done')).toBeInTheDocument()
    expect(within(tbody()).queryByText('trader.error')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Skipped' }))

    expect(await screen.findByText('No events match the current filters')).toBeInTheDocument()
  })

  it('restores filters from the URL and writes updates back to query params', async () => {
    window.history.replaceState({}, '', '/events?type=trader.error&trader=error')
    mocks.api.events.query.mockResolvedValueOnce({
      entries: [
        {
          seq: 2,
          ts: Date.now(),
          type: 'trader.error',
          payload: { strategyId: 'breakout', error: 'Rejected.' },
        },
        {
          seq: 1,
          ts: Date.now() - 1_000,
          type: 'trader.done',
          payload: { strategyId: 'momentum', reason: 'Filled.' },
        },
      ],
      page: 1,
      pageSize: 100,
      total: 2,
      totalPages: 1,
    })

    render(<EventsPage />)

    expect(await screen.findByDisplayValue('trader.error')).toBeInTheDocument()
    expect(screen.getByText(/1 shown/)).toBeInTheDocument()
    expect(mocks.api.events.query).toHaveBeenCalledWith({
      page: 1,
      pageSize: 100,
      type: 'trader.error',
    })

    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(window.location.search).toContain('type=trader.error')
    expect(window.location.search).toContain('trader=review')

    await userEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    expect(window.location.search).toContain('tab=cron')
  })

  it('creates cron jobs from the cron tab form', async () => {
    render(<EventsPage />)

    await userEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    expect(await screen.findByText('Morning Review')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '+ Add Job' }))
    await userEvent.type(screen.getByPlaceholderText('Job name'), 'Lunch Scan')
    await userEvent.type(screen.getByPlaceholderText('Payload / instruction text'), 'scan equities')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(mocks.api.cron.add).toHaveBeenCalledWith({
        name: 'Lunch Scan',
        payload: 'scan equities',
        schedule: { kind: 'every', every: '1h' },
      })
    })
  })

  it('toggles, runs, expands, and deletes cron jobs', async () => {
    render(<EventsPage />)

    await userEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    expect(await screen.findByText('Morning Review')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('switch'))
    await waitFor(() => {
      expect(mocks.api.cron.update).toHaveBeenCalledWith('job-1', { enabled: false })
    })

    await userEvent.click(screen.getByTitle('Run now'))
    await waitFor(() => {
      expect(mocks.api.cron.runNow).toHaveBeenCalledWith('job-1')
    })

    await userEvent.click(screen.getByTitle('Details'))
    expect(await screen.findByText(/Payload:/)).toBeInTheDocument()
    expect(screen.getByText('review market structure')).toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Delete'))
    await waitFor(() => {
      expect(mocks.api.cron.remove).toHaveBeenCalledWith('job-1')
    })
  })

  it('shows an error when cron actions fail', async () => {
    mocks.api.cron.runNow.mockRejectedValueOnce(new Error('boom'))

    render(<EventsPage />)

    await userEvent.click(screen.getByRole('button', { name: 'Cron Jobs' }))
    expect(await screen.findByText('Morning Review')).toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Run now'))

    expect(await screen.findByText('Failed to run job')).toBeInTheDocument()
  })
})
