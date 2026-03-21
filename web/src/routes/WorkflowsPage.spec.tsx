import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowsPage } from './WorkflowsPage'

const mocks = vi.hoisted(() => ({
  api: {
    workflows: {
      listTraderRuns: vi.fn(),
      getTraderRun: vi.fn(),
    },
  },
  useSSE: vi.fn(),
}))

vi.mock('../api', () => ({
  api: mocks.api,
}))

vi.mock('../hooks/useSSE', () => ({
  useSSE: mocks.useSSE,
}))

describe('WorkflowsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.api.workflows.listTraderRuns.mockResolvedValue({
      entries: [
        {
          runId: '12',
          jobId: 'job-1',
          jobName: 'BTCUSDT',
          strategyId: 'mean-revert',
          startedAt: Date.now() - 20_000,
          endedAt: Date.now() - 5_000,
          durationMs: 15_000,
          status: 'skip',
          endedStage: 'market-scan',
          headline: 'BTC/USDT:USDT on Main Account: No rejection candle.',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 30,
      totalPages: 1,
    })
    mocks.api.workflows.getTraderRun.mockResolvedValue({
      summary: {
        runId: '12',
        jobId: 'job-1',
        jobName: 'BTCUSDT',
        strategyId: 'mean-revert',
        startedAt: Date.now() - 20_000,
        endedAt: Date.now() - 5_000,
        durationMs: 15_000,
        status: 'skip',
        endedStage: 'market-scan',
        headline: 'BTC/USDT:USDT on Main Account: No rejection candle.',
      },
      stages: [
        {
          seq: 20,
          ts: Date.now() - 10_000,
          stage: 'market-scan',
          status: 'skipped',
          data: {
            summary: '',
            candidates: [],
            evaluations: [
              {
                source: 'Main Account',
                symbol: 'BTC/USDT:USDT',
                verdict: 'skip',
                reason: 'No rejection candle on 5m.',
              },
            ],
            agentTrace: {
              skillId: 'trader-market-scan',
              resources: ['checklist'],
              requiredScriptCalls: [
                {
                  id: 'analysis-brooks',
                  rationale: 'Need execution timeframe structure before deciding.',
                },
              ],
              scriptCalls: [
                {
                  id: 'analysis-brooks',
                  input: {
                    asset: 'crypto',
                    symbol: 'BTC/USDT:USDT',
                    timeframes: { context: '1h', structure: '15m', execution: '5m' },
                  },
                },
              ],
              iterations: 2,
              completionRejectedCount: 1,
            },
          },
        },
      ],
      terminalEvent: {
        seq: 21,
        ts: Date.now() - 5_000,
        type: 'trader.skip',
        payload: {
          reason: 'BTC/USDT:USDT on Main Account: No rejection candle.',
        },
      },
    })
  })

  it('renders workflow run list and parsed stage cards', async () => {
    render(<WorkflowsPage />)

    expect(await screen.findByText('mean-revert')).toBeInTheDocument()
    expect(await screen.findByText('Market Scan')).toBeInTheDocument()
    expect(screen.getByText('BTC/USDT:USDT')).toBeInTheDocument()
    expect(screen.getAllByText('Main Account').length).toBeGreaterThan(0)
    expect(screen.getByText('No rejection candle on 5m.')).toBeInTheDocument()
    expect(screen.getByText('Agent Trace')).toBeInTheDocument()
    expect(screen.getByText('2 iterations')).toBeInTheDocument()
    expect(screen.getByText('1 completion retries')).toBeInTheDocument()
    expect(screen.getAllByText('analysis-brooks').length).toBeGreaterThan(0)
    expect(screen.getByText('Need execution timeframe structure before deciding.')).toBeInTheDocument()
    expect(screen.getByText('Loaded Resources')).toBeInTheDocument()
    expect(screen.getByText('Terminal Event')).toBeInTheDocument()
  })

  it('refreshes the selected run when matching trader SSE arrives', async () => {
    let lastConfig: { onMessage: (entry: any) => void } | undefined
    mocks.useSSE.mockImplementation((config) => {
      lastConfig = config
    })

    render(<WorkflowsPage />)
    await screen.findByText('mean-revert')
    expect(mocks.api.workflows.getTraderRun).toHaveBeenCalledTimes(1)

    act(() => {
      lastConfig?.onMessage({
        type: 'trader.stage',
        payload: { runId: '12' },
      })
    })

    expect(mocks.api.workflows.listTraderRuns).toHaveBeenCalledTimes(2)
    expect(mocks.api.workflows.getTraderRun).toHaveBeenCalledTimes(2)
  })

  it('shows raw json when expanded', async () => {
    render(<WorkflowsPage />)
    await screen.findByText('mean-revert')

    await userEvent.click(await screen.findByText('Raw JSON'))

    const pre = await screen.findByText((content, node) =>
      node?.tagName.toLowerCase() === 'pre' && content.includes('"evaluations"'),
    )
    expect(pre).toBeInTheDocument()
    expect(within(pre).getByText(/No rejection candle on 5m/)).toBeInTheDocument()
  })
})
