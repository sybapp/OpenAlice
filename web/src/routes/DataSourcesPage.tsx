import { useState } from 'react'
import { type AppConfig, type NewsCollectorConfig, type NewsCollectorFeed } from '../api'
import { SaveIndicator } from '../components/SaveIndicator'
import { Section, Field, inputClass } from '../components/form'
import { Toggle } from '../components/Toggle'
import { useConfigPage } from '../hooks/useConfigPage'

export function DataSourcesPage() {
  const news = useConfigPage<NewsCollectorConfig>({
    section: 'newsCollector',
    extract: (full: AppConfig) => (full as Record<string, unknown>).newsCollector as NewsCollectorConfig,
  })

  const loadError = news.loadError
  const retry = () => { news.retry() }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 border-b border-border">
        <div className="px-4 md:px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text">Data Sources</h2>
            <p className="text-[12px] text-text-muted mt-1">
              RSS/Atom news feed configuration.
            </p>
          </div>
          <SaveIndicator status={news.status} onRetry={retry} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[640px] space-y-8">
          {news.config && (
            <>
              <NewsCollectorSettingsSection
                config={news.config}
                onChange={news.updateConfig}
                onChangeImmediate={news.updateConfigImmediate}
              />
              <FeedsSection
                feeds={news.config.feeds}
                onChange={(feeds) => news.updateConfigImmediate({ feeds })}
              />
            </>
          )}
        </div>
        {loadError && <p className="text-[13px] text-red mt-4">Failed to load configuration.</p>}
      </div>
    </div>
  )
}

interface NewsSettingsProps {
  config: NewsCollectorConfig
  onChange: (patch: Partial<NewsCollectorConfig>) => void
  onChangeImmediate: (patch: Partial<NewsCollectorConfig>) => void
}

function NewsCollectorSettingsSection({ config, onChange, onChangeImmediate }: NewsSettingsProps) {
  return (
    <Section
      title="News Collector"
      description="RSS/Atom feed aggregation settings. Collected articles are searchable via archive tools."
    >
      <Field label="Enabled">
        <Toggle
          checked={config.enabled}
          onChange={(v) => onChangeImmediate({ enabled: v })}
        />
      </Field>

      <Field label="Fetch Interval (minutes)">
        <input
          className={inputClass}
          type="number"
          min={1}
          value={config.intervalMinutes}
          onChange={(e) => onChange({ intervalMinutes: Number(e.target.value) || 10 })}
        />
      </Field>

      <Field label="Retention (days)">
        <input
          className={inputClass}
          type="number"
          min={1}
          value={config.retentionDays}
          onChange={(e) => onChange({ retentionDays: Number(e.target.value) || 7 })}
        />
      </Field>
    </Section>
  )
}

function FeedsSection({
  feeds,
  onChange,
}: {
  feeds: NewsCollectorFeed[]
  onChange: (feeds: NewsCollectorFeed[]) => void
}) {
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newSource, setNewSource] = useState('')

  const removeFeed = (index: number) => {
    onChange(feeds.filter((_, i) => i !== index))
  }

  const addFeed = () => {
    if (!newName.trim() || !newUrl.trim() || !newSource.trim()) return
    onChange([...feeds, { name: newName.trim(), url: newUrl.trim(), source: newSource.trim() }])
    setNewName('')
    setNewUrl('')
    setNewSource('')
  }

  return (
    <Section
      title="RSS Feeds"
      description="Add or remove RSS/Atom feeds. Changes take effect on the next fetch cycle."
    >
      {feeds.length > 0 && (
        <div className="space-y-2 mb-4">
          {feeds.map((feed, i) => (
            <div
              key={`${feed.source}-${i}`}
              className="flex items-center gap-3 border border-border rounded-lg px-3 py-2.5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-text truncate">{feed.name}</p>
                <p className="text-[11px] text-text-muted truncate">{feed.url}</p>
                <p className="text-[10px] text-text-muted/60 mt-0.5">source: {feed.source}</p>
              </div>
              <button
                onClick={() => removeFeed(i)}
                className="shrink-0 text-text-muted hover:text-red transition-colors p-1"
                title="Remove feed"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {feeds.length === 0 && (
        <p className="text-[12px] text-text-muted mb-4">No feeds configured.</p>
      )}

      <div className="border border-border/60 rounded-lg p-3 space-y-2">
        <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-1">Add Feed</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] text-text-muted mb-0.5">Name</label>
            <input
              className={inputClass}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. CoinDesk"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-muted mb-0.5">Source Tag</label>
            <input
              className={inputClass}
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="e.g. coindesk"
            />
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-text-muted mb-0.5">Feed URL</label>
          <input
            className={inputClass}
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://example.com/rss.xml"
          />
        </div>
        <button
          onClick={addFeed}
          disabled={!newName.trim() || !newUrl.trim() || !newSource.trim()}
          className="border border-border rounded-lg px-4 py-2 text-[13px] font-medium cursor-pointer transition-colors hover:bg-bg-tertiary hover:text-text text-text-muted disabled:opacity-40 disabled:cursor-default"
        >
          Add Feed
        </button>
      </div>
    </Section>
  )
}
