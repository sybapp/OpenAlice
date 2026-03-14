import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type AppConfig, type AIProviderConfig } from '../api'
import { AIProviderPage } from './AIProviderPage'

const config: AppConfig = {
  aiProvider: {
    backend: 'vercel-ai-sdk',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKeys: {
      anthropic: true,
      openai: false,
      google: false,
    },
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

describe('AIProviderPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sets and clears provider keys without revealing current values', async () => {
    vi.spyOn(api.config, 'load').mockResolvedValue(config)
    const updateSpy = vi.spyOn(api.config, 'updateSection')
      .mockResolvedValueOnce({
        data: {
          ...config.aiProvider,
          apiKeys: {
            anthropic: true,
            openai: true,
            google: false,
          },
        } satisfies AIProviderConfig,
      })
      .mockResolvedValueOnce({
        data: {
          ...config.aiProvider,
          apiKeys: {
            anthropic: false,
            openai: true,
            google: false,
          },
        } satisfies AIProviderConfig,
      })

    render(<AIProviderPage />)

    await screen.findByText('AI Provider')
    await userEvent.click(screen.getByRole('button', { name: /API Keys/i }))

    expect(screen.getByText('Configured')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('OpenAI API Key'), 'openai-secret')
    await userEvent.click(screen.getByLabelText('Set OpenAI API Key'))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('aiProvider', {
      apiKeys: { openai: 'openai-secret' },
    }))

    await userEvent.click(screen.getByLabelText('Clear Anthropic API Key'))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('aiProvider', {
      apiKeys: { anthropic: null },
    }))
  })
})
