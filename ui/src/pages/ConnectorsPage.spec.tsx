import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type ConnectorsConfig } from '../api'
import { ConnectorsPage } from './ConnectorsPage'
import type { SaveStatus } from '../hooks/useAutoSave'

const replaceConfig = vi.fn()
const retry = vi.fn()
const replaceToken = vi.fn()
const refreshAuthState = vi.fn().mockResolvedValue(undefined)
let configStatus: SaveStatus = 'applying'

let connectorsConfig: ConnectorsConfig = {
  web: { port: 3002, hasAuthToken: true },
  mcp: { port: 3001 },
  mcpAsk: { enabled: false, hasAuthToken: false },
  telegram: { enabled: false, hasBotToken: false, chatIds: [] },
}

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: () => ({
    config: connectorsConfig,
    status: configStatus,
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
    configStatus = 'applying'
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

  it('does not clear the mcp-ask token when confirmation is canceled', async () => {
    connectorsConfig = {
      ...connectorsConfig,
      mcpAsk: { enabled: true, port: 3003, hasAuthToken: true },
    }
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const updateSpy = vi.spyOn(api.config, 'updateSection')

    render(<ConnectorsPage />)

    await userEvent.click(screen.getByLabelText('Clear MCP Ask Token'))

    expect(updateSpy).not.toHaveBeenCalled()
    expect(replaceConfig).not.toHaveBeenCalled()
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

  it('keeps the mcp-ask token draft when rotation fails', async () => {
    connectorsConfig = {
      ...connectorsConfig,
      mcpAsk: { enabled: true, port: 3003, hasAuthToken: true },
    }
    vi.spyOn(api.config, 'updateSection').mockRejectedValueOnce(new Error('mcp save failed'))

    render(<ConnectorsPage />)

    await userEvent.type(screen.getByLabelText('Auth Token'), 'mcp-bad-secret')
    await userEvent.click(screen.getByLabelText('Set MCP Ask Token'))

    expect(await screen.findByText('mcp save failed')).toBeInTheDocument()
    expect(screen.getByLabelText('Auth Token')).toHaveValue('mcp-bad-secret')
    expect(replaceConfig).not.toHaveBeenCalled()
  })

  it('keeps the telegram token draft when rotation fails', async () => {
    connectorsConfig = {
      ...connectorsConfig,
      telegram: {
        enabled: true,
        hasBotToken: true,
        botUsername: 'alice_bot',
        chatIds: [1],
      },
    }
    vi.spyOn(api.config, 'updateSection').mockRejectedValueOnce(new Error('telegram save failed'))

    render(<ConnectorsPage />)

    await userEvent.type(screen.getByLabelText('New Bot Token'), 'bad-bot-token')
    await userEvent.click(screen.getByLabelText('Set Telegram Token'))

    expect(await screen.findByText('telegram save failed')).toBeInTheDocument()
    expect(screen.getByLabelText('New Bot Token')).toHaveValue('bad-bot-token')
    expect(replaceConfig).not.toHaveBeenCalled()
  })

  it('does not clear the telegram token when confirmation is canceled', async () => {
    connectorsConfig = {
      ...connectorsConfig,
      telegram: {
        enabled: true,
        hasBotToken: true,
        botUsername: 'alice_bot',
        chatIds: [1],
      },
    }
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const updateSpy = vi.spyOn(api.config, 'updateSection')

    render(<ConnectorsPage />)

    await userEvent.click(screen.getByLabelText('Clear Telegram Token'))

    expect(updateSpy).not.toHaveBeenCalled()
    expect(replaceConfig).not.toHaveBeenCalled()
  })

  it('shows an inline error and keeps the draft token when web token rotation fails', async () => {
    vi.spyOn(api.config, 'updateSection').mockRejectedValueOnce(new Error('save failed'))

    render(<ConnectorsPage />)

    await userEvent.type(screen.getByLabelText('New Token'), 'broken-secret')
    await userEvent.click(screen.getByLabelText('Set Web Token'))

    expect(await screen.findByText('save failed')).toBeInTheDocument()
    expect(screen.getByLabelText('New Token')).toHaveValue('broken-secret')
    expect(replaceConfig).not.toHaveBeenCalled()
  })

  it('renders a retry action when autosave status is error', async () => {
    configStatus = 'error'

    render(<ConnectorsPage />)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalled()
  })

  it('does not clear the web token when confirmation is canceled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const updateSpy = vi.spyOn(api.config, 'updateSection')

    render(<ConnectorsPage />)

    await userEvent.click(screen.getByLabelText('Clear Web Token'))

    expect(updateSpy).not.toHaveBeenCalled()
    expect(replaceConfig).not.toHaveBeenCalled()
    expect(refreshAuthState).not.toHaveBeenCalled()
  })
})
