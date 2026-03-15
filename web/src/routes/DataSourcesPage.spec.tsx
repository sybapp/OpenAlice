import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewsCollectorConfig } from '../api'
import { DataSourcesPage } from './DataSourcesPage'

const newsUpdateConfig = vi.fn()
const newsUpdateConfigImmediate = vi.fn()
const newsRetry = vi.fn()

let newsConfig: NewsCollectorConfig = {
  enabled: true,
  intervalMinutes: 10,
  maxInMemory: 100,
  retentionDays: 7,
  feeds: [],
}

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: () => ({
    config: newsConfig,
    status: 'idle',
    loadError: false,
    updateConfig: newsUpdateConfig,
    updateConfigImmediate: newsUpdateConfigImmediate,
    replaceConfig: vi.fn(),
    retry: newsRetry,
  }),
}))

describe('DataSourcesPage', () => {
  beforeEach(() => {
    newsConfig = {
      enabled: true,
      intervalMinutes: 10,
      maxInMemory: 100,
      retentionDays: 7,
      feeds: [],
    }
    newsUpdateConfig.mockReset()
    newsUpdateConfigImmediate.mockReset()
    newsRetry.mockReset()
  })

  it('updates news collector interval and retention', async () => {
    render(<DataSourcesPage />)
    const inputs = screen.getAllByRole('spinbutton')

    fireEvent.change(inputs[0], { target: { value: '20' } })
    expect(newsUpdateConfig).toHaveBeenCalledWith({ intervalMinutes: 20 })

    fireEvent.change(inputs[1], { target: { value: '30' } })
    expect(newsUpdateConfig).toHaveBeenCalledWith({ retentionDays: 30 })
  })

  it('toggles enabled status immediately', async () => {
    render(<DataSourcesPage />)
    await userEvent.click(screen.getByRole('switch'))
    expect(newsUpdateConfigImmediate).toHaveBeenCalledWith({ enabled: false })
  })

  it('adds a feed entry', async () => {
    render(<DataSourcesPage />)

    await userEvent.type(screen.getByPlaceholderText('e.g. CoinDesk'), 'CoinDesk')
    await userEvent.type(screen.getByPlaceholderText('e.g. coindesk'), 'coindesk')
    await userEvent.type(screen.getByPlaceholderText('https://example.com/rss.xml'), 'https://www.coindesk.com/arc/outboundfeeds/rss/')
    await userEvent.click(screen.getByRole('button', { name: 'Add Feed' }))

    expect(newsUpdateConfigImmediate).toHaveBeenCalledWith({
      feeds: [{
        name: 'CoinDesk',
        source: 'coindesk',
        url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
      }],
    })
  })
})
