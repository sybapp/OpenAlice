import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type ConnectorsConfig } from '../api'
import { ConnectorsPage } from './ConnectorsPage'

const replaceConfig = vi.fn()
const retry = vi.fn()
const replaceToken = vi.fn()
const refreshAuthState = vi.fn().mockResolvedValue(undefined)

let connectorsConfig: ConnectorsConfig = {
  web: { port: 3002, hasAuthToken: true },
  mcp: { port: 3001 },
  mcpAsk: { enabled: false, hasAuthToken: false },
  telegram: { enabled: false, hasBotToken: false, chatIds: [] },
}

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: () => ({
    config: connectorsConfig,
    status: 'applying',
    loadError: false,
    updateConfig: vi.fn(),
    updateConfigImmediate: vi.fn(),
    replaceConfig,
    retry,
  }),
}))

vi.mock('../auth/session', () => ({
  useAuthSession: () => ({
    authRequired: true,
    sessionState: 'ready',
    lock: vi.fn(),
    replaceToken,
    refreshAuthState,
  }),
}))

describe('ConnectorsPage', () => {
  beforeEach(() => {
    connectorsConfig = {
      web: { port: 3002, hasAuthToken: true },
      mcp: { port: 3001 },
      mcpAsk: { enabled: false, hasAuthToken: false },
      telegram: { enabled: false, hasBotToken: false, chatIds: [] },
    }
    sessionStorage.clear()
    replaceConfig.mockReset()
    replaceToken.mockReset()
    refreshAuthState.mockClear()
    retry.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the applying indicator and never pre-fills the current web token', () => {
    render(<ConnectorsPage />)

    expect(screen.getByText('Applying changes...')).toBeInTheDocument()
    expect(screen.getByText('Configured')).toBeInTheDocument()
    expect(screen.getByLabelText('New Token')).toHaveValue('')
  })

  it('rotates the token and updates the current tab session', async () => {
    vi.spyOn(api.config, 'updateSection').mockResolvedValue({
      data: connectorsConfig,
      meta: { reconnectScheduled: true },
    })

    render(<ConnectorsPage />)

    await userEvent.type(screen.getByLabelText('New Token'), 'rotated-secret')
    await userEvent.click(screen.getByLabelText('Set Web Token'))

    await waitFor(() => expect(api.config.updateSection).toHaveBeenCalledWith('connectors', {
      web: { authToken: 'rotated-secret' },
    }))
    expect(replaceConfig).toHaveBeenCalledWith(connectorsConfig)
    expect(replaceToken).toHaveBeenCalledWith('rotated-secret')
    expect(screen.getByLabelText('New Token')).toHaveValue('')
  })

  it('clears the token and removes the current tab session token', async () => {
    sessionStorage.setItem('authToken', 'persisted-token')
    vi.spyOn(api.config, 'updateSection').mockResolvedValue({
      data: {
        ...connectorsConfig,
        web: { port: 3002, hasAuthToken: false },
      },
      meta: { reconnectScheduled: true },
    })

    render(<ConnectorsPage />)

    await userEvent.click(screen.getByLabelText('Clear Web Token'))

    await waitFor(() => expect(api.config.updateSection).toHaveBeenCalledWith('connectors', {
      web: { clearAuthToken: true },
    }))
    expect(replaceConfig).toHaveBeenCalledWith({
      ...connectorsConfig,
      web: { port: 3002, hasAuthToken: false },
    })
    expect(sessionStorage.getItem('authToken')).toBeNull()
    expect(refreshAuthState).toHaveBeenCalled()
  })

  it('rotates the mcp-ask token without exposing the current value', async () => {
    connectorsConfig = {
      ...connectorsConfig,
      mcpAsk: { enabled: true, port: 3003, hasAuthToken: true },
    }
    vi.spyOn(api.config, 'updateSection').mockResolvedValue({
      data: connectorsConfig,
      meta: { reconnectScheduled: true },
    })

    render(<ConnectorsPage />)

    await userEvent.type(screen.getByLabelText('Auth Token'), 'mcp-rotated-secret')
    await userEvent.click(screen.getByLabelText('Set MCP Ask Token'))

    await waitFor(() => expect(api.config.updateSection).toHaveBeenCalledWith('connectors', {
      mcpAsk: { authToken: 'mcp-rotated-secret' },
    }))
    expect(replaceConfig).toHaveBeenCalledWith(connectorsConfig)
    expect(screen.getByLabelText('Auth Token')).toHaveValue('')
  })

  it('clears the telegram bot token while keeping other telegram settings editable', async () => {
    connectorsConfig = {
      ...connectorsConfig,
      telegram: {
        enabled: true,
        hasBotToken: true,
        botUsername: 'alice_bot',
        chatIds: [1, 2],
      },
    }
    vi.spyOn(api.config, 'updateSection').mockResolvedValue({
      data: {
        ...connectorsConfig,
        telegram: {
          ...connectorsConfig.telegram,
          hasBotToken: false,
        },
      },
      meta: { reconnectScheduled: true },
    })

    render(<ConnectorsPage />)

    expect(screen.getByText('Bot token configured')).toBeInTheDocument()
    expect(screen.getByLabelText('Bot Username')).toHaveValue('alice_bot')
    await userEvent.click(screen.getByLabelText('Clear Telegram Token'))

    await waitFor(() => expect(api.config.updateSection).toHaveBeenCalledWith('connectors', {
      telegram: { clearBotToken: true },
    }))
    expect(replaceConfig).toHaveBeenCalledWith({
      ...connectorsConfig,
      telegram: {
        ...connectorsConfig.telegram,
        hasBotToken: false,
      },
    })
  })
})
