import { useEffect, useRef, useState } from 'react'
import type { SaveStatus } from './useAutoSave'

export interface SecretFieldActionState<TKey extends string> {
  key: TKey | null
  status: SaveStatus
  error: string | null
}

export function useSecretFieldAction<TKey extends string>() {
  const [state, setState] = useState<SecretFieldActionState<TKey>>({
    key: null,
    status: 'idle',
    error: null,
  })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const reset = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState({ key: null, status: 'idle', error: null })
  }

  const setSaving = (key: TKey) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState({ key, status: 'saving', error: null })
  }

  const setError = (key: TKey, error: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState({ key, status: 'error', error })
  }

  const clearError = (key: TKey) => {
    setState((current) => (
      current.key === key && current.status === 'error'
        ? { key: null, status: 'idle', error: null }
        : current
    ))
  }

  const setTransientStatus = (
    key: TKey,
    status: Extract<SaveStatus, 'saved' | 'applying'>,
    durationMs = 2000,
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState({ key, status, error: null })
    timerRef.current = setTimeout(() => {
      setState((current) => (
        current.key === key
          ? { key: null, status: 'idle', error: null }
          : current
      ))
    }, durationMs)
  }

  const isSaving = (key: TKey) => state.key === key && state.status === 'saving'

  const errorFor = (key: TKey) => (
    state.key === key && state.status === 'error' ? state.error : null
  )

  return {
    state,
    reset,
    setSaving,
    setError,
    clearError,
    setTransientStatus,
    isSaving,
    errorFor,
  }
}
