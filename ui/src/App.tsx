import { Suspense, lazy, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'

const ChatPage = lazy(async () => {
  const mod = await import('./pages/ChatPage')
  return { default: mod.ChatPage }
})
const PortfolioPage = lazy(async () => {
  const mod = await import('./pages/PortfolioPage')
  return { default: mod.PortfolioPage }
})
const EventsPage = lazy(async () => {
  const mod = await import('./pages/EventsPage')
  return { default: mod.EventsPage }
})
const SettingsPage = lazy(async () => {
  const mod = await import('./pages/SettingsPage')
  return { default: mod.SettingsPage }
})
const AIProviderPage = lazy(async () => {
  const mod = await import('./pages/AIProviderPage')
  return { default: mod.AIProviderPage }
})
const DataSourcesPage = lazy(async () => {
  const mod = await import('./pages/DataSourcesPage')
  return { default: mod.DataSourcesPage }
})
const TradingPage = lazy(async () => {
  const mod = await import('./pages/TradingPage')
  return { default: mod.TradingPage }
})
const ConnectorsPage = lazy(async () => {
  const mod = await import('./pages/ConnectorsPage')
  return { default: mod.ConnectorsPage }
})
const DevPage = lazy(async () => {
  const mod = await import('./pages/DevPage')
  return { default: mod.DevPage }
})
const HeartbeatPage = lazy(async () => {
  const mod = await import('./pages/HeartbeatPage')
  return { default: mod.HeartbeatPage }
})
const ToolsPage = lazy(async () => {
  const mod = await import('./pages/ToolsPage')
  return { default: mod.ToolsPage }
})

export type Page =
  | 'chat' | 'portfolio' | 'events' | 'heartbeat' | 'data-sources' | 'connectors'
  | 'trading'
  | 'ai-provider' | 'settings' | 'tools' | 'dev'

/** Page type → URL path mapping. Chat is the root, everything else maps to /slug. */
export const ROUTES: Record<Page, string> = {
  'chat': '/',
  'portfolio': '/portfolio',
  'events': '/events',
  'heartbeat': '/heartbeat',
  'data-sources': '/data-sources',
  'connectors': '/connectors',
  'tools': '/tools',
  'trading': '/trading',
  'ai-provider': '/ai-provider',
  'settings': '/settings',
  'dev': '/dev',
}

function RouteFallback() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-sm text-text-muted">
      Loading...
    </div>
  )
}

export function App() {
  const [sseConnected, setSseConnected] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex h-full">
      <Sidebar
        sseConnected={sseConnected}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-bg">
        {/* Mobile header — visible only below md */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary shrink-0 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-text-muted hover:text-text p-1 -ml-1"
            aria-label="Open menu"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-text">Open Alice</span>
        </div>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<ChatPage onSSEStatus={setSseConnected} />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/heartbeat" element={<HeartbeatPage />} />
            <Route path="/data-sources" element={<DataSourcesPage />} />
            <Route path="/connectors" element={<ConnectorsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/trading" element={<TradingPage />} />
            <Route path="/ai-provider" element={<AIProviderPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/dev" element={<DevPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
