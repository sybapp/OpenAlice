import { useState, useEffect, useCallback, useRef } from 'react'
import { api, type AppConfig, type ConfigUpdateResponse } from '../api'
import { useAutoSave, type SaveStatus } from './useAutoSave'

interface UseConfigPageOptions<T, TPayload = T> {
  /** Config section key, e.g. 'crypto', 'securities', 'openbb' */
  section: string
  /** Extract the sub-config from the full AppConfig */
  extract: (full: AppConfig) => T
  /** Auto-save debounce delay in ms (default: 600) */
  delay?: number
  /** Transform local UI state into the payload sent to the backend. */
  toPayload?: (data: T) => TPayload
  /** Derive the success state shown after a save completes. */
  getSuccessStatus?: (result: ConfigUpdateResponse<T>) => Extract<SaveStatus, 'saved' | 'applying'>
}

interface UseConfigPageResult<T> {
  config: T | null
  fullConfig: AppConfig | null
  status: SaveStatus
  loadError: boolean
  /** Update config with debounced auto-save */
  updateConfig: (patch: Partial<T>) => void
  /** Update config and immediately flush (no debounce) */
  updateConfigImmediate: (patch: Partial<T>) => void
  /** Replace local config with the latest server-shaped value. */
  replaceConfig: (next: T) => void
  retry: () => void
}

/**
 * Shared hook for config pages (DataSources, Trading, Securities).
 * Handles: load → autoSave → flush → updateConfig/updateConfigImmediate.
 */
export function useConfigPage<T extends object, TPayload = T>({
  section,
  extract,
  delay = 600,
  toPayload,
  getSuccessStatus,
}: UseConfigPageOptions<T, TPayload>): UseConfigPageResult<T> {
  const [fullConfig, setFullConfig] = useState<AppConfig | null>(null)
  const [config, setConfig] = useState<T | null>(null)
  const [loadError, setLoadError] = useState(false)
  const flushRequestedRef = useRef(false)
  const extractRef = useRef(extract)

  extractRef.current = extract

  const mergePatch = useCallback((patch: Partial<T>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const full = await api.config.load()
      setFullConfig(full)
      setConfig(extractRef.current(full))
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saveConfig = useCallback(
    async (data: T) => {
      const result = await api.config.updateSection<T>(section, toPayload ? toPayload(data) : data)
      setConfig(result.data)
      return { status: getSuccessStatus?.(result) ?? 'saved' }
    },
    [getSuccessStatus, section, toPayload],
  )

  const { status, flush, retry } = useAutoSave({
    data: config!,
    save: saveConfig,
    delay,
    enabled: config !== null,
  })

  // After React commits a state update with flushRequested, trigger immediate save
  useEffect(() => {
    if (flushRequestedRef.current && config) {
      flushRequestedRef.current = false
      flush()
    }
  }, [config, flush])

  const updateConfig = useCallback((patch: Partial<T>) => {
    mergePatch(patch)
  }, [mergePatch])

  const updateConfigImmediate = useCallback((patch: Partial<T>) => {
    flushRequestedRef.current = true
    mergePatch(patch)
  }, [mergePatch])

  const replaceConfig = useCallback((next: T) => {
    setConfig(next)
  }, [])

  return {
    config,
    fullConfig,
    status,
    loadError,
    updateConfig,
    updateConfigImmediate,
    replaceConfig,
    retry: loadError ? load : retry,
  }
}
