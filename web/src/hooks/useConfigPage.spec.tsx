import { renderHook, act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type AppConfig, type ConnectorsConfig } from '../api'
import { useConfigPage } from './useConfigPage'

const baseConfig: AppConfig = {
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

describe('useConfigPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses response.data when saving and surfaces applying status', async () => {
    vi.spyOn(api.config, 'load').mockResolvedValue(baseConfig)
    const updateSpy = vi.spyOn(api.config, 'updateSection').mockResolvedValue({
      data: {
        web: { host: '127.0.0.1', port: 4010, hasAuthToken: true },
        mcp: { host: '127.0.0.1', port: 3001 },
        mcpAsk: { enabled: false, hasAuthToken: false },
        telegram: { enabled: false, hasBotToken: false, chatIds: [] },
      } satisfies ConnectorsConfig,
      meta: { reconnectScheduled: true },
    })

    const { result } = renderHook(() => useConfigPage<ConnectorsConfig>({
      section: 'connectors',
      extract: (full) => full.connectors,
      getSuccessStatus: (response) => response.meta?.reconnectScheduled ? 'applying' : 'saved',
    }))

    await waitFor(() => expect(result.current.config?.web.port).toBe(3002))

    act(() => {
      result.current.updateConfigImmediate({ web: { host: '127.0.0.1', port: 3999, hasAuthToken: true } })
    })

    await waitFor(() => expect(updateSpy).toHaveBeenCalled())
    await waitFor(() => expect(result.current.config?.web.port).toBe(4010))
    expect((result.current.config as unknown as Record<string, unknown>).meta).toBeUndefined()
    expect(result.current.status).toBe('applying')
  })
})
