import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { AuthSessionProvider } from '../auth/session'
import { AuthGate } from './AuthGate'

describe('AuthGate', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('renders the app immediately when auth is disabled', async () => {
    vi.spyOn(api.auth, 'check').mockResolvedValue({ authRequired: false })

    render(
      <AuthSessionProvider>
        <AuthGate>
          <div>Unlocked content</div>
        </AuthGate>
      </AuthSessionProvider>,
    )

    await screen.findByText('Unlocked content')
    expect(screen.queryByText('Enter the Web auth token to unlock this workspace.')).not.toBeInTheDocument()
  })

  it('unlocks the app after a valid token is submitted', async () => {
    vi.spyOn(api.auth, 'check').mockResolvedValue({ authRequired: true })
    const verifySpy = vi.spyOn(api.auth, 'verify').mockResolvedValue({ valid: true })

    render(
      <AuthSessionProvider>
        <AuthGate>
          <div>Unlocked content</div>
        </AuthGate>
      </AuthSessionProvider>,
    )

    await screen.findByText('Enter the Web auth token to unlock this workspace.')
    await userEvent.type(screen.getByLabelText('Auth Token'), 'new-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await screen.findByText('Unlocked content')
    expect(verifySpy).toHaveBeenCalledWith('new-secret')
    expect(sessionStorage.getItem('authToken')).toBe('new-secret')
  })

  it('restores an existing valid token from session storage', async () => {
    sessionStorage.setItem('authToken', 'persisted-token')
    vi.spyOn(api.auth, 'check').mockResolvedValue({ authRequired: true })
    const verifySpy = vi.spyOn(api.auth, 'verify').mockResolvedValue({ valid: true })

    render(
      <AuthSessionProvider>
        <AuthGate>
          <div>Unlocked content</div>
        </AuthGate>
      </AuthSessionProvider>,
    )

    await screen.findByText('Unlocked content')
    await waitFor(() => expect(verifySpy).toHaveBeenCalledWith('persisted-token'))
  })
})
