import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { DataSourcesPage } from './DataSourcesPage'

let openbbConfig = {
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
}

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: ({ section }: { section: string }) => {
    if (section === 'openbb') {
      return {
        config: openbbConfig,
        status: 'idle',
        loadError: false,
        updateConfig: vi.fn(),
        updateConfigImmediate: vi.fn(),
        replaceConfig: vi.fn(),
        retry: vi.fn(),
      }
    }
    return {
      config: {
        enabled: true,
        intervalMinutes: 10,
        maxInMemory: 100,
        retentionDays: 7,
        piggybackOpenBB: true,
        feeds: [],
      },
      status: 'idle',
      loadError: false,
      updateConfig: vi.fn(),
      updateConfigImmediate: vi.fn(),
      replaceConfig: vi.fn(),
      retry: vi.fn(),
    }
  },
}))

describe('DataSourcesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    }
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

    await userEvent.click(screen.getByLabelText('Clear FRED Provider Key'))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('openbb', {
      providerKeys: { fred: null },
    }))
  })
})
