import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { ToolsPage } from './ToolsPage'

describe('ToolsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders capability sections and updates disabled system tools', async () => {
    vi.spyOn(api.tools, 'load').mockResolvedValue({
      systemTools: [
        { name: 'think', group: 'thinking', description: 'Reason in public.' },
        { name: 'cronList', group: 'cron', description: 'List cron jobs.' },
      ],
      skills: [
        {
          id: 'trader-trade-thesis',
          label: 'Trader Trade Thesis',
          description: 'Produce a structured trade thesis.',
          runtime: 'script-loop',
          userInvocable: true,
          stage: 'trade-thesis',
          resources: [],
          allowedScripts: ['analysis-brooks'],
        },
      ],
      scripts: [
        {
          id: 'analysis-brooks',
          description: 'Run Brooks analysis.',
          usedBy: ['trader-trade-thesis'],
        },
      ],
      mcpExposed: [
        {
          id: 'skill__trader-trade-thesis',
          kind: 'skill',
          description: 'Invoke the trader trade thesis capability.',
        },
      ],
      disabledSystemTools: ['cronList'],
    })

    const updateSpy = vi.spyOn(api.tools, 'update').mockResolvedValue({
      disabledSystemTools: ['cronList', 'think'],
    })

    render(<ToolsPage />)

    expect(await screen.findByText('Capabilities')).toBeInTheDocument()
    expect(screen.getByText('Script Skills')).toBeInTheDocument()
    expect(screen.getByText('Scripts')).toBeInTheDocument()
    expect(screen.getByText('MCP Exposed')).toBeInTheDocument()
    expect(screen.getByText('Trader Trade Thesis')).toBeInTheDocument()
    expect(screen.getByText('analysis-brooks')).toBeInTheDocument()
    expect(screen.getByText('skill__trader-trade-thesis')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Thinking Kit/i }))
    await userEvent.click(screen.getAllByRole('switch')[1])

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(['cronList', 'think']))
  })
})
