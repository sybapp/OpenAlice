import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSSE } from './useSSE'

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
}

function Harness(props: Parameters<typeof useSSE>[0]) {
  useSSE(props)
  return null
}

describe('useSSE', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    vi.useFakeTimers()
    sessionStorage.clear()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('connects with the auth token, parses messages, and closes cleanly on unmount', () => {
    const onMessage = vi.fn()
    const onStatus = vi.fn()
    sessionStorage.setItem('authToken', 'secret-token')

    const view = render(
      <Harness
        url="/api/chat/events"
        onMessage={onMessage}
        onStatus={onStatus}
      />,
    )

    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toBe('/api/chat/events?authToken=secret-token')

    act(() => {
      MockEventSource.instances[0].onopen?.()
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ type: 'stream', ok: true }),
      } as MessageEvent<string>)
    })

    expect(onStatus).toHaveBeenCalledWith(true)
    expect(onMessage).toHaveBeenCalledWith({ type: 'stream', ok: true })

    view.unmount()

    expect(MockEventSource.instances[0].close).toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith(false)
  })

  it('reconnects after connection errors with backoff', () => {
    const onStatus = vi.fn()

    render(
      <Harness
        url="/api/chat/events"
        onMessage={vi.fn()}
        onStatus={onStatus}
      />,
    )

    expect(MockEventSource.instances).toHaveLength(1)

    act(() => {
      MockEventSource.instances[0].onerror?.()
    })

    expect(onStatus).toHaveBeenCalledWith(false)
    expect(MockEventSource.instances[0].close).toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(MockEventSource.instances).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockEventSource.instances).toHaveLength(2)
  })
})
