import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type NewsCollectorConfig, type OpenbbConfig } from '../api'
import { DataSourcesPage } from './DataSourcesPage'

const openbbUpdateConfig = vi.fn()
const openbbUpdateConfigImmediate = vi.fn()
const openbbReplaceConfig = vi.fn()
const openbbRetry = vi.fn()

const newsUpdateConfig = vi.fn()
const newsUpdateConfigImmediate = vi.fn()
const newsRetry = vi.fn()

let openbbConfig: OpenbbConfig = {
  enabled: true,
  apiUrl: 'http://localhost:6900',
  providers: {
    equity: 'yfinance',
    crypto: 'yfinance',
    currency: 'yfinance',
    newsCompany: 'yfinance',
    newsWorld: 'fmp',
  },
  providerKeys: {
    fred: true,
    fmp: false,
  },
  dataBackend: 'sdk',
  apiServer: {
    enabled: false,
    port: 6901,
  },
}

const newsConfig: NewsCollectorConfig = {
  enabled: true,
  intervalMinutes: 10,
  maxInMemory: 100,
  retentionDays: 7,
  piggybackOpenBB: true,
  feeds: [],
}

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: ({ section }: { section: string }) => {
    if (section === 'openbb') {
      return {
        config: openbbConfig,
        status: 'idle',
        loadError: false,
        updateConfig: openbbUpdateConfig,
        updateConfigImmediate: openbbUpdateConfigImmediate,
        replaceConfig: openbbReplaceConfig,
        retry: openbbRetry,
      }
    }

    return {
      config: newsConfig,
      status: 'idle',
      loadError: false,
      updateConfig: newsUpdateConfig,
      updateConfigImmediate: newsUpdateConfigImmediate,
      replaceConfig: vi.fn(),
      retry: newsRetry,
    }
  },
}))

describe('DataSourcesPage', () => {
  beforeEach(() => {
    openbbConfig = {
      enabled: true,
      apiUrl: 'http://localhost:6900',
      providers: {
        equity: 'yfinance',
        crypto: 'yfinance',
        currency: 'yfinance',
        newsCompany: 'yfinance',
        newsWorld: 'fmp',
      },
      providerKeys: {
        fred: true,
        fmp: false,
      },
      dataBackend: 'sdk',
      apiServer: {
        enabled: false,
        port: 6901,
      },
    }

    openbbUpdateConfig.mockReset()
    openbbUpdateConfigImmediate.mockReset()
    openbbReplaceConfig.mockReset()
    openbbRetry.mockReset()
    newsUpdateConfig.mockReset()
    newsUpdateConfigImmediate.mockReset()
    newsRetry.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('updates provider keys explicitly instead of autosaving masked values', async () => {
    const updateSpy = vi.spyOn(api.config, 'updateSection')
      .mockResolvedValueOnce({
        data: {
          ...openbbConfig,
          providerKeys: {
            ...openbbConfig.providerKeys,
            fmp: true,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          ...openbbConfig,
          providerKeys: {
            fred: false,
            fmp: true,
          },
        },
      })

    render(<DataSourcesPage />)

    await userEvent.click(screen.getByRole('button', { name: /Provider API Keys/i }))
    await userEvent.type(screen.getByLabelText('FMP Provider Key'), 'fmp-secret')
    await userEvent.click(screen.getByLabelText('Set FMP Provider Key'))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('openbb', {
      providerKeys: { fmp: 'fmp-secret' },
    }))
    expect(openbbReplaceConfig).toHaveBeenCalledWith({
      ...openbbConfig,
      providerKeys: {
        ...openbbConfig.providerKeys,
        fmp: true,
      },
    })

    await userEvent.click(screen.getByLabelText('Clear FRED Provider Key'))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('openbb', {
      providerKeys: { fred: null },
    }))
  })

  it('defaults to sdk mode and updates backend and embedded api server settings explicitly', async () => {
    render(<DataSourcesPage />)

    expect(screen.getByRole('button', { name: 'SDK Mode' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Test Connection/i })).not.toBeInTheDocument()
    expect(screen.getByText(/OpenTypeBB in-process/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'External OpenBB' }))
    expect(openbbUpdateConfigImmediate).toHaveBeenCalledWith({ dataBackend: 'openbb' })

    openbbConfig = {
      ...openbbConfig,
      dataBackend: 'openbb',
    }
  })

  it('shows external openbb connection fields and lets users edit server settings', async () => {
    openbbConfig = {
      ...openbbConfig,
      dataBackend: 'openbb',
    }

    render(<DataSourcesPage />)

    expect(screen.getByRole('button', { name: /Test Connection/i })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('API URL'), {
      target: { value: 'http://remote-host:7000' },
    })
    expect(openbbUpdateConfig).toHaveBeenCalledWith({
      apiUrl: 'http://remote-host:7000',
    })

    await userEvent.click(screen.getAllByRole('switch')[0])
    expect(openbbUpdateConfigImmediate).toHaveBeenCalledWith({
      apiServer: {
        enabled: true,
        port: 6901,
      },
    })

    const serverPortInput = screen.getByDisplayValue('6901')
    fireEvent.change(serverPortInput, {
      target: { value: '7001' },
    })
    expect(openbbUpdateConfig).toHaveBeenCalledWith({
      apiServer: {
        enabled: false,
        port: 7001,
      },
    })
  })
})
