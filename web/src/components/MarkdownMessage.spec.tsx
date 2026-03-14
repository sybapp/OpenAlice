import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'

describe('MarkdownMessage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    })
  })

  it('wraps fenced code blocks and copies their contents', async () => {
    render(<MarkdownMessage text={'```ts\nconst answer = 42\n```'} />)

    expect(screen.getByText('ts')).toBeInTheDocument()
    const copyButton = await screen.findByRole('button', { name: /copy/i })
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const answer = 42\n')
    })
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument()
  })

  it('renders authenticated media URLs and prefix content', () => {
    sessionStorage.setItem('authToken', 'secret-token')

    render(
      <MarkdownMessage
        text="**Market structure**"
        prefixText="<p>Preface</p>"
        media={[{ type: 'image', url: '/api/media/chart.png' }]}
      />,
    )

    expect(screen.getByText('Preface')).toBeInTheDocument()
    const image = document.querySelector('img')
    expect(image).toHaveAttribute('src', '/api/media/chart.png?authToken=secret-token')
  })
})
