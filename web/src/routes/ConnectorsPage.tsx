import { useState } from 'react'
import { api, type AppConfig, type ConnectorsConfig, type UpdateConnectorsRequest } from '../api'
import { clearAuthToken } from '../api/client'
import { useAuthSession } from '../auth/session'
import { SaveIndicator } from '../components/SaveIndicator'
import { SecretFieldEditor } from '../components/SecretFieldEditor'
import { SDKSelector, CONNECTOR_OPTIONS } from '../components/SDKSelector'
import { Section, Field, inputClass } from '../components/form'
import { useConfigPage } from '../hooks/useConfigPage'
import { useSecretFieldAction } from '../hooks/useSecretFieldAction'
import type { SaveStatus } from '../hooks/useAutoSave'

type CredentialKey = 'web' | 'mcpAsk' | 'telegram'

function combineStatus(...statuses: SaveStatus[]): SaveStatus {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('saving')) return 'saving'
  if (statuses.includes('applying')) return 'applying'
  if (statuses.includes('saved')) return 'saved'
  return 'idle'
}

function toConnectorsPayload(config: ConnectorsConfig): UpdateConnectorsRequest {
  return {
    web: {
      host: config.web.host,
      port: config.web.port,
    },
    mcp: { ...config.mcp },
    mcpAsk: {
      enabled: config.mcpAsk.enabled,
      port: config.mcpAsk.port,
    },
    telegram: {
      enabled: config.telegram.enabled,
      botUsername: config.telegram.botUsername,
      chatIds: config.telegram.chatIds,
    },
  }
}

interface ConnectorSecretFieldConfig {
  key: CredentialKey
  label: string
  configured: boolean
  value: string
  onChange: (value: string) => void
  onSet: () => void
  onClear: () => void
  inputAriaLabel: string
  setAriaLabel: string
  clearAriaLabel: string
  configuredLabel?: string
  configuredPlaceholder: string
  emptyPlaceholder: string
  configuredSetLabel: string
  emptySetLabel: string
  clearLabel: string
}

function ConnectorSecretField({
  field,
  isSaving,
  error,
}: {
  field: ConnectorSecretFieldConfig
  isSaving: boolean
  error?: string | null
}) {
  return (
    <Field label={field.label}>
      <SecretFieldEditor
        configured={field.configured}
        value={field.value}
        onChange={field.onChange}
        onSet={field.onSet}
        onClear={field.onClear}
        setDisabled={isSaving || !field.value.trim()}
        clearDisabled={isSaving || !field.configured}
        inputAriaLabel={field.inputAriaLabel}
        setAriaLabel={field.setAriaLabel}
        clearAriaLabel={field.clearAriaLabel}
        configuredLabel={field.configuredLabel}
        configuredPlaceholder={field.configuredPlaceholder}
        emptyPlaceholder={field.emptyPlaceholder}
        configuredSetLabel={field.configuredSetLabel}
        emptySetLabel={field.emptySetLabel}
        clearLabel={field.clearLabel}
        error={error}
      />
    </Field>
  )
}

function buildConnectorSecretField(
  base: Pick<ConnectorSecretFieldConfig, 'key' | 'label' | 'configured' | 'value' | 'onChange' | 'onSet' | 'onClear' | 'inputAriaLabel' | 'setAriaLabel' | 'clearAriaLabel'>,
  overrides?: Partial<Pick<ConnectorSecretFieldConfig, 'configuredLabel' | 'configuredPlaceholder' | 'emptyPlaceholder' | 'configuredSetLabel' | 'emptySetLabel' | 'clearLabel'>>,
): ConnectorSecretFieldConfig {
  return {
    ...base,
    configuredPlaceholder: 'Rotate token',
    emptyPlaceholder: 'Set token',
    configuredSetLabel: 'Set New Token',
    emptySetLabel: 'Set Token',
    clearLabel: 'Clear Token',
    ...overrides,
  }
}

export function ConnectorsPage() {
  const { replaceToken, refreshAuthState } = useAuthSession()
  const {
    config,
    status: configStatus,
    loadError,
    updateConfig,
    updateConfigImmediate,
    replaceConfig,
    retry,
  } = useConfigPage<ConnectorsConfig, UpdateConnectorsRequest>({
    section: 'connectors',
    extract: (full: AppConfig) => full.connectors,
    toPayload: toConnectorsPayload,
    getSuccessStatus: (result) => result.meta?.reconnectScheduled ? 'applying' : 'saved',
  })
  const credential = useSecretFieldAction<CredentialKey>()
  const [webTokenDraft, setWebTokenDraft] = useState('')
  const [mcpAskTokenDraft, setMcpAskTokenDraft] = useState('')
  const [telegramTokenDraft, setTelegramTokenDraft] = useState('')
  const status = combineStatus(configStatus, credential.state.status)

  const selected = config
    ? [
        'web',
        'mcp',
        ...(config.mcpAsk.enabled ? ['mcpAsk'] : []),
        ...(config.telegram.enabled ? ['telegram'] : []),
      ]
    : ['web', 'mcp']

  const handleToggle = (id: string) => {
    if (!config) return
    if (id === 'mcpAsk') {
      updateConfigImmediate({
        mcpAsk: { ...config.mcpAsk, enabled: !config.mcpAsk.enabled },
      })
    } else if (id === 'telegram') {
      updateConfigImmediate({
        telegram: { ...config.telegram, enabled: !config.telegram.enabled },
      })
    }
  }

  const handleCredentialUpdate = async (
    key: CredentialKey,
    payload: UpdateConnectorsRequest,
    onSuccess?: (next: ConnectorsConfig) => Promise<void> | void,
  ) => {
    credential.setSaving(key)

    try {
      const result = await api.config.updateSection<ConnectorsConfig>('connectors', payload)
      replaceConfig(result.data)
      await onSuccess?.(result.data)
      credential.setTransientStatus(key, result.meta?.reconnectScheduled ? 'applying' : 'saved')
    } catch (err) {
      credential.setError(key, err instanceof Error ? err.message : 'Failed to update credential')
    }
  }

  const handleSetWebToken = async () => {
    const value = webTokenDraft.trim()
    if (!value) {
      credential.setError('web', 'Token is required')
      return
    }

    await handleCredentialUpdate(
      'web',
      { web: { authToken: value } },
      async () => {
        replaceToken(value)
        setWebTokenDraft('')
      },
    )
  }

  const handleClearWebToken = async () => {
    if (!config?.web.hasAuthToken) return
    if (!window.confirm('Clear the Web auth token? This will remove login protection for the Web UI.')) {
      return
    }

    await handleCredentialUpdate(
      'web',
      { web: { clearAuthToken: true } },
      async () => {
        clearAuthToken()
        setWebTokenDraft('')
        await refreshAuthState()
      },
    )
  }

  const handleSetMcpAskToken = async () => {
    const value = mcpAskTokenDraft.trim()
    if (!value) {
      credential.setError('mcpAsk', 'Token is required')
      return
    }

    await handleCredentialUpdate(
      'mcpAsk',
      { mcpAsk: { authToken: value } },
      async () => {
        setMcpAskTokenDraft('')
      },
    )
  }

  const handleClearMcpAskToken = async () => {
    if (!config?.mcpAsk.hasAuthToken) return
    if (!window.confirm('Clear the MCP Ask auth token? Requests to the MCP Ask endpoint will no longer require a bearer token.')) {
      return
    }

    await handleCredentialUpdate(
      'mcpAsk',
      { mcpAsk: { clearAuthToken: true } },
      async () => {
        setMcpAskTokenDraft('')
      },
    )
  }

  const handleSetTelegramToken = async () => {
    const value = telegramTokenDraft.trim()
    if (!value) {
      credential.setError('telegram', 'Token is required')
      return
    }

    await handleCredentialUpdate(
      'telegram',
      { telegram: { botToken: value } },
      async () => {
        setTelegramTokenDraft('')
      },
    )
  }

  const handleClearTelegramToken = async () => {
    if (!config?.telegram.hasBotToken) return
    if (!window.confirm('Clear the Telegram bot token? The Telegram connector will stop until a new token is configured.')) {
      return
    }

    await handleCredentialUpdate(
      'telegram',
      { telegram: { clearBotToken: true } },
      async () => {
        setTelegramTokenDraft('')
      },
    )
  }

  const webSecretField = buildConnectorSecretField({
    key: 'web',
    label: 'New Token',
    configured: config?.web.hasAuthToken ?? false,
    value: webTokenDraft,
    onChange: (value) => {
      setWebTokenDraft(value)
      credential.clearError('web')
    },
    onSet: handleSetWebToken,
    onClear: handleClearWebToken,
    inputAriaLabel: 'New Token',
    setAriaLabel: 'Set Web Token',
    clearAriaLabel: 'Clear Web Token',
  })

  const mcpAskSecretField = buildConnectorSecretField({
    key: 'mcpAsk',
    label: 'Auth Token',
    configured: config?.mcpAsk.hasAuthToken ?? false,
    value: mcpAskTokenDraft,
    onChange: (value) => {
      setMcpAskTokenDraft(value)
      credential.clearError('mcpAsk')
    },
    onSet: handleSetMcpAskToken,
    onClear: handleClearMcpAskToken,
    inputAriaLabel: 'Auth Token',
    setAriaLabel: 'Set MCP Ask Token',
    clearAriaLabel: 'Clear MCP Ask Token',
  })

  const telegramSecretField = buildConnectorSecretField({
    key: 'telegram',
    label: 'New Bot Token',
    configured: config?.telegram.hasBotToken ?? false,
    value: telegramTokenDraft,
    onChange: (value) => {
      setTelegramTokenDraft(value)
      credential.clearError('telegram')
    },
    onSet: handleSetTelegramToken,
    onClear: handleClearTelegramToken,
    inputAriaLabel: 'New Bot Token',
    setAriaLabel: 'Set Telegram Token',
    clearAriaLabel: 'Clear Telegram Token',
  }, {
    configuredLabel: 'Bot token configured',
    configuredPlaceholder: 'Rotate bot token',
    emptyPlaceholder: 'Set bot token',
  })

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 border-b border-border">
        <div className="px-4 md:px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text">Connectors</h2>
            <p className="text-[12px] text-text-muted mt-1">
              Service ports and external integrations. Changes save automatically and apply in the background.
            </p>
          </div>
          <SaveIndicator status={status} onRetry={retry} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        {config && (
          <div className="max-w-[640px] space-y-8">
            <Section
              title="Active Connectors"
              description="Select which connectors to enable. Web UI and MCP Server are always active."
            >
              <SDKSelector
                options={CONNECTOR_OPTIONS}
                selected={selected}
                onToggle={handleToggle}
              />
            </Section>

            <Section
              title="Web UI"
              description="Browser-based chat and configuration interface."
            >
              <Field label="Host">
                <input
                  className={inputClass}
                  value={config.web.host}
                  onChange={(e) => updateConfig({ web: { ...config.web, host: e.target.value } })}
                  placeholder="127.0.0.1"
                />
              </Field>
              <Field label="Port">
                <input
                  className={inputClass}
                  type="number"
                  value={config.web.port}
                  onChange={(e) => updateConfig({ web: { ...config.web, port: Number(e.target.value) } })}
                />
              </Field>
            </Section>

            <Section
              title="Web Auth"
              description="Protect the Web UI with a shared token. The current token value is never shown again after it is saved."
            >
              <ConnectorSecretField
                field={webSecretField}
                isSaving={credential.isSaving(webSecretField.key)}
                error={credential.errorFor(webSecretField.key)}
              />
            </Section>

            <Section
              title="MCP Server"
              description="Tool bridge for Claude Code provider and external AI agents."
            >
              <Field label="Host">
                <input
                  className={inputClass}
                  value={config.mcp.host}
                  onChange={(e) => updateConfig({ mcp: { ...config.mcp, host: e.target.value } })}
                  placeholder="127.0.0.1"
                />
              </Field>
              <Field label="Port">
                <input
                  className={inputClass}
                  type="number"
                  value={config.mcp.port}
                  onChange={(e) => updateConfig({ mcp: { ...config.mcp, port: Number(e.target.value) } })}
                />
              </Field>
            </Section>

            {config.mcpAsk.enabled && (
              <Section
                title="MCP Ask"
                description="Multi-turn conversation endpoint for external agents."
              >
                <Field label="Port">
                  <input
                    className={inputClass}
                    type="number"
                    value={config.mcpAsk.port ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      updateConfig({ mcpAsk: { ...config.mcpAsk, port: v ? Number(v) : undefined } })
                    }}
                    placeholder="e.g. 3003"
                  />
                </Field>

                <ConnectorSecretField
                  field={mcpAskSecretField}
                  isSaving={credential.isSaving(mcpAskSecretField.key)}
                  error={credential.errorFor(mcpAskSecretField.key)}
                />
              </Section>
            )}

            {config.telegram.enabled && (
              <Section
                title="Telegram"
                description="Create a bot via @BotFather, store the token here, and allow the chat IDs that can use it."
              >
                <ConnectorSecretField
                  field={telegramSecretField}
                  isSaving={credential.isSaving(telegramSecretField.key)}
                  error={credential.errorFor(telegramSecretField.key)}
                />

                <Field label="Bot Username">
                  <input
                    className={inputClass}
                    value={config.telegram.botUsername ?? ''}
                    onChange={(e) =>
                      updateConfig({
                        telegram: { ...config.telegram, botUsername: e.target.value || undefined },
                      })
                    }
                    placeholder="my_bot"
                  />
                </Field>
                <Field label="Allowed Chat IDs">
                  <input
                    className={inputClass}
                    value={config.telegram.chatIds.join(', ')}
                    onChange={(e) =>
                      updateConfig({
                        telegram: {
                          ...config.telegram,
                          chatIds: e.target.value
                            ? e.target.value
                                .split(',')
                                .map((s) => Number(s.trim()))
                                .filter((n) => !isNaN(n))
                            : [],
                        },
                      })
                    }
                    placeholder="Comma-separated, e.g. 123456, 789012"
                  />
                </Field>

              </Section>
            )}
          </div>
        )}
        {loadError && <p className="text-[13px] text-red">Failed to load configuration.</p>}
      </div>
    </div>
  )
}
