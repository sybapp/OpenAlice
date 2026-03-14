/** Auth token management for session-based authentication. */
const AUTH_KEY = 'authToken'

export function setAuthToken(token: string) {
  sessionStorage.setItem(AUTH_KEY, token)
}

export function clearAuthToken() {
  sessionStorage.removeItem(AUTH_KEY)
}

export function getAuthToken(): string | null {
  return sessionStorage.getItem(AUTH_KEY)
}

/** Shared fetch headers for JSON requests. */
export const headers = { 'Content-Type': 'application/json' }

export function getAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = { ...headers }
  const token = getAuthToken()
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export function withAuthQuery(url: string): string {
  const token = getAuthToken()
  if (!token) return url

  const parsed = new URL(url, window.location.origin)
  parsed.searchParams.set('authToken', token)

  if (parsed.origin === window.location.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  }
  return parsed.toString()
}

export async function fetchApi(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...getAuthHeaders(), ...init?.headers },
  })
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const err = await res.json().catch(() => ({ error: fallback }))
  return err.error || fallback
}

/** Fetch helper that throws on non-OK responses. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchApi(url, init)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, res.statusText))
  }
  return res.json()
}

export async function fetchJsonOrThrow<T>(
  url: string,
  init: RequestInit,
  fallbackMessage: string,
): Promise<T> {
  const res = await fetchApi(url, init)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, fallbackMessage))
  }
  return res.json()
}

export async function fetchOkOrThrow(
  url: string,
  init: RequestInit,
  fallbackMessage: string,
): Promise<void> {
  const res = await fetchApi(url, init)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, fallbackMessage))
  }
}
