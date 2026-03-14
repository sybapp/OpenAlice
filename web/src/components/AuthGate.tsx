import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import { clearAuthToken } from '../api/client'
import { useAuthSession } from '../auth/session'

function RouteFallback() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-sm text-text-muted">
      Loading...
    </div>
  )
}

function LoginGate() {
  const { replaceToken } = useAuthSession()
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const value = token.trim()
      if (!value) {
        setError('Token is required')
        return
      }

      const result = await api.auth.verify(value)
      if (!result.valid) {
        clearAuthToken()
        setError('Invalid token')
        return
      }

      replaceToken(value)
    } catch (err) {
      clearAuthToken()
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-bg">
      <form onSubmit={handleSubmit} className="w-full max-w-[420px] rounded-2xl border border-border bg-bg-secondary/70 p-6 shadow-xl">
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-text">Open Alice</h1>
          <p className="mt-2 text-sm text-text-muted">Enter the Web auth token to unlock this workspace.</p>
        </div>

        <label className="block text-sm text-text-muted mb-2" htmlFor="auth-token">Auth Token</label>
        <input
          id="auth-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
          className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-sm text-text outline-none focus:border-accent"
          placeholder="Paste token"
        />

        {error && (
          <p className="mt-3 text-sm text-red">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-5 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-black disabled:opacity-60"
        >
          {submitting ? 'Verifying...' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { sessionState } = useAuthSession()

  if (sessionState === 'checking') {
    return <RouteFallback />
  }

  if (sessionState === 'locked') {
    return <LoginGate />
  }

  return <>{children}</>
}
