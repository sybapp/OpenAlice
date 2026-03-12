import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type AppConfig } from '../api'
import { useAuthSession } from '../auth/session'
import { Toggle } from '../components/Toggle'
import { SaveIndicator } from '../components/SaveIndicator'
import { Section, Field, inputClass } from '../components/form'
import { useAutoSave } from '../hooks/useAutoSave'

function getSessionCopy(authRequired: boolean, sessionState: 'checking' | 'ready' | 'locked') {
  if (!authRequired) {
    return {
      title: 'Web auth is off for this workspace.',
      description: 'Anyone who can reach the Web UI can open it without a token.',
      canLock: false,
    }
  }

  return {
    title: sessionState === 'ready' ? 'Unlocked for this tab.' : 'This tab is currently locked.',
    description: 'Locking only clears the token from this tab. Other tabs keep their own session state.',
    canLock: sessionState === 'ready',
  }
}

export function SettingsPage() {
  const { authRequired, sessionState, lock } = useAuthSession()
  const [config, setConfig] = useState<AppConfig | null>(null)
  const sessionCopy = getSessionCopy(authRequired, sessionState)

  useEffect(() => {
    api.config.load().then(setConfig).catch(() => {})
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 border-b border-border">
        <div className="px-4 md:px-6 py-4">
          <h2 className="text-base font-semibold text-text">Settings</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        {config && (
          <div className="max-w-[640px] space-y-8">
            <Section
              id="web-session"
              title="Web Session"
              description="Session controls for the current browser tab."
            >
              <div className="rounded-lg border border-border bg-bg-secondary/40 px-4 py-3">
                <p className="text-sm text-text">{sessionCopy.title}</p>
                <p className="mt-1 text-[12px] text-text-muted">{sessionCopy.description}</p>
                {sessionCopy.canLock && (
                  <button
                    onClick={lock}
                    className="mt-3 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-text transition-colors hover:bg-bg-tertiary"
                  >
                    Lock this tab
                  </button>
                )}
              </div>
            </Section>

            {/* Agent */}
            <Section id="agent" title="Agent" description="Controls file-system and tool permissions for the AI. Changes apply on the next request.">
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-3">
                  <span className="text-sm">
                    Evolution Mode: {config.agent?.evolutionMode ? 'Enabled' : 'Disabled'}
                  </span>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    {config.agent?.evolutionMode
                      ? 'Full project access — AI can modify source code'
                      : 'Sandbox mode — AI can only edit data/brain/'}
                  </p>
                </div>
                <Toggle
                  checked={config.agent?.evolutionMode || false}
                  onChange={async (v) => {
                    try {
                      await api.config.updateSection('agent', { ...config.agent, evolutionMode: v })
                      setConfig((c) => c ? { ...c, agent: { ...c.agent, evolutionMode: v } } : c)
                    } catch {
                      // Toggle doesn't flip on failure
                    }
                  }}
                />
              </div>
            </Section>

            {/* Compaction */}
            <Section id="compaction" title="Compaction" description="Context window management. When conversation size approaches Max Context minus Max Output tokens, older messages are automatically summarized to free up space. Set Max Context to match your model's context limit.">
              <CompactionForm config={config} />
            </Section>


          </div>
        )}
      </div>
    </div>
  )
}

// ==================== Form Sections ====================

function CompactionForm({ config }: { config: AppConfig }) {
  const [ctx, setCtx] = useState(String(config.compaction?.maxContextTokens || ''))
  const [out, setOut] = useState(String(config.compaction?.maxOutputTokens || ''))

  const data = useMemo(
    () => ({ maxContextTokens: Number(ctx), maxOutputTokens: Number(out) }),
    [ctx, out],
  )

  const save = useCallback(async (d: { maxContextTokens: number; maxOutputTokens: number }) => {
    await api.config.updateSection('compaction', d)
  }, [])

  const { status, retry } = useAutoSave({ data, save })

  return (
    <>
      <Field label="Max Context Tokens">
        <input className={inputClass} type="number" step={1000} value={ctx} onChange={(e) => setCtx(e.target.value)} />
      </Field>
      <Field label="Max Output Tokens">
        <input className={inputClass} type="number" step={1000} value={out} onChange={(e) => setOut(e.target.value)} />
      </Field>
      <SaveIndicator status={status} onRetry={retry} />
    </>
  )
}
