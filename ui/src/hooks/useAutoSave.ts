import { useState, useRef, useCallback, useEffect } from 'react'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'applying' | 'error'
type SaveCompletionStatus = Extract<SaveStatus, 'saved' | 'applying'>

export interface SaveResult {
  status?: SaveCompletionStatus
}

interface UseAutoSaveOptions<T> {
  data: T
  save: (data: T) => Promise<void | SaveResult>
  delay?: number
  enabled?: boolean
}

export function useAutoSave<T>({
  data,
  save,
  delay = 600,
  enabled = true,
}: UseAutoSaveOptions<T>): { status: SaveStatus; flush: () => void; retry: () => void } {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestDataRef = useRef<T>(data)
  const saveRef = useRef(save)
  const inflightRef = useRef(false)
  const initialRef = useRef(true)
  const pendingRef = useRef(false)

  latestDataRef.current = data
  saveRef.current = save

  const clearSaveTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }

  const clearStatusTimer = () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
  }

  const runSave = useCallback(async () => {
    if (inflightRef.current) {
      pendingRef.current = true
      return
    }
    inflightRef.current = true
    setStatus('saving')
    try {
      const result = await saveRef.current(latestDataRef.current)
      setStatus(result?.status ?? 'saved')
      clearStatusTimer()
      statusTimerRef.current = setTimeout(() => setStatus('idle'), 2000)
      if (pendingRef.current) {
        pendingRef.current = false
        inflightRef.current = false
        void runSave()
        return
      }
    } catch {
      setStatus('error')
    } finally {
      inflightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (initialRef.current) {
      initialRef.current = false
      return
    }
    clearSaveTimer()
    timerRef.current = setTimeout(runSave, delay)
    return () => {
      clearSaveTimer()
    }
  }, [data, delay, enabled, runSave])

  useEffect(() => {
    return () => {
      clearSaveTimer()
      clearStatusTimer()
    }
  }, [])

  const flush = useCallback(() => {
    clearSaveTimer()
    void runSave()
  }, [runSave])

  const retry = useCallback(() => {
    void runSave()
  }, [runSave])

  return { status, flush, retry }
}
