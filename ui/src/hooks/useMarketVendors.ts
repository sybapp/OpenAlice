import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { MarketVendorInfo } from '../api/openbb'

export function useMarketVendors() {
  const [vendors, setVendors] = useState<MarketVendorInfo[] | null>(null)
  const [error, setError] = useState(false)
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(false)
    api.marketData.vendors()
      .then((result) => { if (!cancelled) setVendors(result.vendors) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [requestVersion])

  const retry = useCallback(() => {
    setVendors(null)
    setError(false)
    setRequestVersion((version) => version + 1)
  }, [])

  return { vendors, error, retry }
}
