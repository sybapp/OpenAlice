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

vi.mock('./pages/ChatPage', () => ({
  ChatPage: ({ onSSEStatus }: { onSSEStatus?: (connected: boolean) => void }) => {
    React.useEffect(() => {
      onSSEStatus?.(true)
    }, [onSSEStatus])
    return <div>Chat Page</div>
  },
}))

vi.mock('./pages/PortfolioPage', () => ({ PortfolioPage: () => <div>Portfolio Page</div> }))
vi.mock('./pages/EventsPage', () => ({ EventsPage: () => <div>Events Page</div> }))
vi.mock('./pages/HeartbeatPage', () => ({ HeartbeatPage: () => <div>Heartbeat Page</div> }))
vi.mock('./pages/DataSourcesPage', () => ({ DataSourcesPage: () => <div>Data Sources Page</div> }))
vi.mock('./pages/ConnectorsPage', () => ({ ConnectorsPage: () => <div>Connectors Page</div> }))
vi.mock('./pages/ToolsPage', () => ({ ToolsPage: () => <div>Tools Page</div> }))
vi.mock('./pages/TradingPage', () => ({ TradingPage: () => <div>Trading Page</div> }))
vi.mock('./pages/TraderPage', () => ({ TraderPage: () => <div>Trader Page</div> }))
vi.mock('./pages/BacktestPage', () => ({ BacktestPage: () => <div>Backtest Page</div> }))
vi.mock('./pages/AIProviderPage', () => ({ AIProviderPage: () => <div>AI Provider Page</div> }))
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <div>Settings Page</div> }))
vi.mock('./pages/DevPage', () => ({ DevPage: () => <div>Dev Page</div> }))

describe('App', () => {
  it('renders the requested route inside the app shell', async () => {
    render(
      <MemoryRouter initialEntries={['/trader']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Trader Page')).toBeInTheDocument()
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
