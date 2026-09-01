// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarketVendors } from './useMarketVendors'

const mocks = vi.hoisted(() => ({ vendors: vi.fn() }))

vi.mock('../api', () => ({ api: { marketData: { vendors: mocks.vendors } } }))

beforeEach(() => vi.clearAllMocks())

describe('useMarketVendors', () => {
  it('selects vendors and recovers from a transient load failure', async () => {
    const recovered = [{ id: 'tradingview', name: 'TradingView', coverage: 'Global' }]
    mocks.vendors.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ vendors: recovered })
    const { result } = renderHook(() => useMarketVendors())

    expect(result.current).toMatchObject({ vendors: null, error: false })
    await waitFor(() => expect(result.current.error).toBe(true))
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.vendors).toEqual(recovered))
    expect(result.current.error).toBe(false)
    expect(mocks.vendors).toHaveBeenCalledTimes(2)
  })
})
