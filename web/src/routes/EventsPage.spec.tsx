import { act, render, screen, waitFor } from '@testing-library/react'
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
        payload: { strategyId: 'momentum' },
      })
    })

    expect((await screen.findAllByText('trader.done')).length).toBeGreaterThan(0)

    await userEvent.click(screen.getByRole('button', { name: /pause/i }))

    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument()
    expect(mocks.useSSE).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    )
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
