import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type AppConfig } from '../api'
import { AuthSessionProvider } from '../auth/session'
import { SettingsPage } from './SettingsPage'

const config: AppConfig = {
  aiProvider: {
    backend: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKeys: {},
  },
  engine: {},
  agent: { evolutionMode: false, claudeCode: {} },
  compaction: { maxContextTokens: 1, maxOutputTokens: 1 },
  heartbeat: { enabled: false, every: '1h', prompt: '', activeHours: null },
  connectors: {
    web: { host: '127.0.0.1', port: 3002, hasAuthToken: true },
    mcp: { host: '127.0.0.1', port: 3001 },
    mcpAsk: { enabled: false, hasAuthToken: false },
    telegram: { enabled: false, hasBotToken: false, chatIds: [] },
  },
}

describe('SettingsPage', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows and executes the tab lock control when web auth is enabled', async () => {
    sessionStorage.setItem('authToken', 'persisted-token')
    vi.spyOn(api.config, 'load').mockResolvedValue(config)
    vi.spyOn(api.auth, 'check').mockResolvedValue({ authRequired: true })
    vi.spyOn(api.auth, 'verify').mockResolvedValue({ valid: true })

    render(
      <AuthSessionProvider>
        <SettingsPage />
      </AuthSessionProvider>,
    )

    await screen.findByText('Unlocked for this tab.')
    await userEvent.click(screen.getByRole('button', { name: 'Lock this tab' }))

    await waitFor(() => expect(screen.getByText('This tab is currently locked.')).toBeInTheDocument())
    expect(sessionStorage.getItem('authToken')).toBeNull()
  })
})
