import { Suspense, lazy, useState, type ComponentType } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { AuthSessionProvider } from './auth/session'
import { AuthGate } from './components/AuthGate'

function lazyPage<T extends Record<string, ComponentType<any>>>(loader: () => Promise<T>, key: keyof T) {
  return lazy(async () => {
    const mod = await loader()
    return { default: mod[key] }
  })
}

const ChatPage = lazyPage(() => import('./routes/ChatPage'), 'ChatPage')
const PortfolioPage = lazyPage(() => import('./routes/PortfolioPage'), 'PortfolioPage')
const EventsPage = lazyPage(() => import('./routes/EventsPage'), 'EventsPage')
const WorkflowsPage = lazyPage(() => import('./routes/WorkflowsPage'), 'WorkflowsPage')
const SettingsPage = lazyPage(() => import('./routes/SettingsPage'), 'SettingsPage')
const AIProviderPage = lazyPage(() => import('./routes/AIProviderPage'), 'AIProviderPage')
const DataSourcesPage = lazyPage(() => import('./routes/DataSourcesPage'), 'DataSourcesPage')
const TradingPage = lazyPage(() => import('./routes/TradingPage'), 'TradingPage')
const StrategiesPage = lazyPage(() => import('./routes/StrategiesPage'), 'StrategiesPage')
const BacktestPage = lazyPage(() => import('./routes/BacktestPage'), 'BacktestPage')
const ConnectorsPage = lazyPage(() => import('./routes/ConnectorsPage'), 'ConnectorsPage')
const DevPage = lazyPage(() => import('./routes/DevPage'), 'DevPage')
const HeartbeatPage = lazyPage(() => import('./routes/HeartbeatPage'), 'HeartbeatPage')
const ToolsPage = lazyPage(() => import('./routes/ToolsPage'), 'ToolsPage')

export type Page =
  | 'chat' | 'portfolio' | 'events' | 'workflows' | 'heartbeat' | 'data-sources' | 'connectors'
  | 'trading' | 'strategies' | 'backtest'
  | 'ai-provider' | 'settings' | 'tools' | 'dev'

/** Page type → URL path mapping. Chat is the root, everything else maps to /slug. */
export const ROUTES: Record<Page, string> = {
  'chat': '/',
  'portfolio': '/portfolio',
  'events': '/events',
  'workflows': '/workflows',
  'heartbeat': '/heartbeat',
  'data-sources': '/data-sources',
  'connectors': '/connectors',
  'tools': '/tools',
  'trading': '/trading',
  'strategies': '/strategies',
  'backtest': '/backtest',
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

function AppShell() {
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
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/heartbeat" element={<HeartbeatPage />} />
            <Route path="/data-sources" element={<DataSourcesPage />} />
            <Route path="/connectors" element={<ConnectorsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/trading" element={<TradingPage />} />
            <Route path="/strategies" element={<StrategiesPage />} />
            <Route path="/trader" element={<Navigate to="/strategies" replace />} />
            <Route path="/backtest" element={<BacktestPage />} />
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

export function App() {
  return (
    <AuthSessionProvider>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </AuthSessionProvider>
  )
}
