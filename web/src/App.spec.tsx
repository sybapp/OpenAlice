import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'

vi.mock('./auth/session', () => ({
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('./components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ sseConnected }: { sseConnected: boolean }) => (
    <div data-testid="sidebar-state">{sseConnected ? 'connected' : 'disconnected'}</div>
  ),
}))

vi.mock('./routes/ChatPage', () => ({
  ChatPage: ({ onSSEStatus }: { onSSEStatus?: (connected: boolean) => void }) => {
    React.useEffect(() => {
      onSSEStatus?.(true)
    }, [onSSEStatus])
    return <div>Chat Page</div>
  },
}))

vi.mock('./routes/PortfolioPage', () => ({ PortfolioPage: () => <div>Portfolio Page</div> }))
vi.mock('./routes/EventsPage', () => ({ EventsPage: () => <div>Events Page</div> }))
vi.mock('./routes/WorkflowsPage', () => ({ WorkflowsPage: () => <div>Workflows Page</div> }))
vi.mock('./routes/HeartbeatPage', () => ({ HeartbeatPage: () => <div>Heartbeat Page</div> }))
vi.mock('./routes/DataSourcesPage', () => ({ DataSourcesPage: () => <div>Data Sources Page</div> }))
vi.mock('./routes/ConnectorsPage', () => ({ ConnectorsPage: () => <div>Connectors Page</div> }))
vi.mock('./routes/ToolsPage', () => ({ ToolsPage: () => <div>Tools Page</div> }))
vi.mock('./routes/TradingPage', () => ({ TradingPage: () => <div>Trading Page</div> }))
vi.mock('./routes/StrategiesPage', () => ({ StrategiesPage: () => <div>Strategies Page</div> }))
vi.mock('./routes/BacktestPage', () => ({ BacktestPage: () => <div>Backtest Page</div> }))
vi.mock('./routes/AIProviderPage', () => ({ AIProviderPage: () => <div>AI Provider Page</div> }))
vi.mock('./routes/SettingsPage', () => ({ SettingsPage: () => <div>Settings Page</div> }))
vi.mock('./routes/DevPage', () => ({ DevPage: () => <div>Dev Page</div> }))

describe('App', () => {
  it('renders the requested route inside the app shell', async () => {
    render(
      <MemoryRouter initialEntries={['/strategies']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Strategies Page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('disconnected')
  })

  it('redirects unknown routes to chat and forwards SSE status to the sidebar', async () => {
    render(
      <MemoryRouter initialEntries={['/unknown']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Chat Page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-state')).toHaveTextContent('connected')
  })
})
