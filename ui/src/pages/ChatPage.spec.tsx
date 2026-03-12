import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { ChatPage } from './ChatPage'

type SSEMessage = (data: any) => void

let sseMessage: SSEMessage = () => {}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn((options: { onMessage: SSEMessage; onStatus?: (connected: boolean) => void }) => {
    sseMessage = options.onMessage
    options.onStatus?.(true)
  }),
}))

describe('ChatPage streaming', () => {
  beforeEach(() => {
    sseMessage = () => {}
    vi.restoreAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
    vi.spyOn(api.chat, 'history').mockResolvedValue({ messages: [] })
  })

  it('shows streaming tool/text progress and persists streamed tool calls after completion', async () => {
    const sendDeferred = createDeferred<{ text: string; media: Array<{ type: 'image'; url: string }>; requestId: string }>()
    vi.spyOn(api.chat, 'send').mockReturnValue(sendDeferred.promise)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-1111-1111-111111111111')

    render(<ChatPage />)

    await userEvent.type(screen.getByPlaceholderText('Message Alice...'), 'hello')
    await userEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith('hello', '11111111-1111-1111-1111-111111111111'))

    await act(async () => {
      sseMessage({
        type: 'stream',
        requestId: '11111111-1111-1111-1111-111111111111',
        event: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'README.md' } },
      })
      sseMessage({
        type: 'stream',
        requestId: '11111111-1111-1111-1111-111111111111',
        event: { type: 'text', text: 'draft answer' },
      })
    })

    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('draft answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument()

    await act(async () => {
      sseMessage({
        type: 'stream',
        requestId: '11111111-1111-1111-1111-111111111111',
        event: { type: 'tool_result', tool_use_id: 'tool-1', content: 'file loaded' },
      })
      sendDeferred.resolve({
        text: 'final answer',
        media: [],
        requestId: '11111111-1111-1111-1111-111111111111',
      })
      await sendDeferred.promise
    })

    await waitFor(() => expect(screen.getByText('final answer')).toBeInTheDocument())
    expect(screen.queryByText('draft answer')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read' })).toBeInTheDocument()
  })
})
