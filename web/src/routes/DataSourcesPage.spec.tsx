import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type NewsCollectorConfig, type OpentypebbConfig } from '../api'
import { DataSourcesPage } from './DataSourcesPage'

const openbbUpdateConfig = vi.fn()
const openbbUpdateConfigImmediate = vi.fn()
const openbbReplaceConfig = vi.fn()
const openbbRetry = vi.fn()

const newsUpdateConfig = vi.fn()
const newsUpdateConfigImmediate = vi.fn()
const newsRetry = vi.fn()

let openbbConfig: OpentypebbConfig = {
  enabled: true,
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
}

const newsConfig: NewsCollectorConfig = {
  enabled: true,
  intervalMinutes: 10,
  maxInMemory: 100,
  retentionDays: 7,
  piggybackOpenTypeBB: true,
  feeds: [],
}

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: ({ section }: { section: string }) => {
    if (section === 'opentypebb') {
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

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('opentypebb', {
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
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('opentypebb', {
      providerKeys: { fred: null },
    }))
  })

  it('renders the built-in OpenTypeBB SDK mode without external server controls', () => {
    render(<DataSourcesPage />)

    expect(screen.getAllByText(/built-in OpenTypeBB SDK/i).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /External OpenTypeBB/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Test Connection/i })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('switch')).toHaveLength(1)
    expect(screen.getByText(/no Python sidecar and no external OpenTypeBB server dependency/i)).toBeInTheDocument()
  })

  it('updates default providers immediately in sdk-only mode', async () => {
    render(<DataSourcesPage />)

    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'fmp')
    expect(openbbUpdateConfigImmediate).toHaveBeenCalledWith({
      providers: {
        ...openbbConfig.providers,
        equity: 'fmp',
      },
    })
  })

  it('keeps provider key drafts and shows inline errors when saving fails', async () => {
    vi.spyOn(api.config, 'updateSection').mockRejectedValueOnce(new Error('provider save failed'))

    render(<DataSourcesPage />)

    await userEvent.click(screen.getByRole('button', { name: /Provider API Keys/i }))
    await userEvent.type(screen.getByLabelText('FMP Provider Key'), 'fmp-secret')
    await userEvent.click(screen.getByLabelText('Set FMP Provider Key'))

    expect(await screen.findByText('provider save failed')).toBeInTheDocument()
    expect(screen.getByLabelText('FMP Provider Key')).toHaveValue('fmp-secret')
    expect(openbbReplaceConfig).not.toHaveBeenCalled()
  })

  it('marks provider connection tests as failed when the API check throws', async () => {
    vi.spyOn(api.opentypebb, 'testProvider').mockRejectedValueOnce(new Error('network down'))

    render(<DataSourcesPage />)

    await userEvent.click(screen.getByRole('button', { name: /Provider API Keys/i }))
    await userEvent.type(screen.getByLabelText('FMP Provider Key'), 'fmp-secret')
    const fmpField = screen.getByText('FMP').closest('label')
    expect(fmpField).toBeTruthy()
    await userEvent.click(within(fmpField as HTMLLabelElement).getByRole('button', { name: 'Test' }))

    expect(await within(fmpField as HTMLLabelElement).findByRole('button', { name: 'Fail' })).toBeInTheDocument()
  })
})
