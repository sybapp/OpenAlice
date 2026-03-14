import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api'
import { clearAuthToken, getAuthToken, setAuthToken } from '../api/client'

export type AuthSessionState = 'checking' | 'ready' | 'locked'

export interface AuthSessionContextValue {
  authRequired: boolean
  sessionState: AuthSessionState
  lock: () => void
  replaceToken: (token: string) => void
  refreshAuthState: () => Promise<void>
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

async function resolveAuthState(): Promise<{ authRequired: boolean; sessionState: AuthSessionState }> {
  const { authRequired } = await api.auth.check()
  if (!authRequired) {
    return { authRequired: false, sessionState: 'ready' }
  }

  const token = getAuthToken()
  if (!token) {
    return { authRequired: true, sessionState: 'locked' }
  }

  const result = await api.auth.verify(token)
  if (result.valid) {
    return { authRequired: true, sessionState: 'ready' }
  }

  clearAuthToken()
  return { authRequired: true, sessionState: 'locked' }
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [authRequired, setAuthRequired] = useState(false)
  const [sessionState, setSessionState] = useState<AuthSessionState>('checking')

  const refreshAuthState = useCallback(async () => {
    setSessionState('checking')
    try {
      const next = await resolveAuthState()
      setAuthRequired(next.authRequired)
      setSessionState(next.sessionState)
    } catch {
      clearAuthToken()
      setAuthRequired(true)
      setSessionState('locked')
    }
  }, [])

  useEffect(() => {
    void refreshAuthState()
  }, [refreshAuthState])

  const lock = useCallback(() => {
    clearAuthToken()
    setSessionState((prev) => (authRequired && prev !== 'checking' ? 'locked' : 'ready'))
  }, [authRequired])

  const replaceToken = useCallback((token: string) => {
    setAuthToken(token)
    setAuthRequired(true)
    setSessionState('ready')
  }, [])

  const value = useMemo<AuthSessionContextValue>(() => ({
    authRequired,
    sessionState,
    lock,
    replaceToken,
    refreshAuthState,
  }), [authRequired, lock, refreshAuthState, replaceToken, sessionState])

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>
}

export function useAuthSession(): AuthSessionContextValue {
  const value = useContext(AuthSessionContext)
  if (!value) {
    throw new Error('useAuthSession must be used within an AuthSessionProvider')
  }
  return value
}
