/** Auth token management for session-based authentication. */
const AUTH_KEY = 'authToken'

export function setAuthToken(token: string) {
  sessionStorage.setItem(AUTH_KEY, token)
}

export function clearAuthToken() {
  sessionStorage.removeItem(AUTH_KEY)
}

/** Shared fetch headers for JSON requests. */
export const headers = { 'Content-Type': 'application/json' }

function getHeaders(): Record<string, string> {
  const h: Record<string, string> = { ...headers }
  const token = sessionStorage.getItem(AUTH_KEY)
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

/** Fetch helper that throws on non-OK responses. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...getHeaders(), ...init?.headers },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}
