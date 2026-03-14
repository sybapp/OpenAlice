import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'

describe('Sidebar', () => {
  it('shows connection status and highlights the active route', () => {
    render(
      <MemoryRouter initialEntries={['/strategies']}>
        <Sidebar sseConnected={true} open={false} onClose={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Strategies/i })).toHaveClass('bg-bg-tertiary')
  })

  it('closes from backdrop and when a nav link is clicked', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar sseConnected={false} open={true} onClose={onClose} />
      </MemoryRouter>,
    )

    const backdrop = document.querySelector('.fixed.inset-0.bg-black\\/50.z-40.md\\:hidden')
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop!)
    fireEvent.click(screen.getByRole('link', { name: /Portfolio/i }))

    expect(screen.getByText('Reconnecting...')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
