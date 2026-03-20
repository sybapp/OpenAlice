import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrategiesPage } from './StrategiesPage'

const { strategiesApi } = vi.hoisted(() => ({
  strategiesApi: {
    listTemplates: vi.fn(),
    listStrategies: vi.fn(),
    createStrategy: vi.fn(),
    updateStrategy: vi.fn(),
    generateStrategy: vi.fn(),
    listJobs: vi.fn(),
    listReviewJobs: vi.fn(),
    getStrategy: vi.fn(),
    runReview: vi.fn(),
    addJob: vi.fn(),
    updateJob: vi.fn(),
    removeJob: vi.fn(),
    runJob: vi.fn(),
    addReviewJob: vi.fn(),
    updateReviewJob: vi.fn(),
    removeReviewJob: vi.fn(),
    runReviewJob: vi.fn(),
  },
}))

const { eventsApi } = vi.hoisted(() => ({
  eventsApi: {
    recent: vi.fn(),
  },
}))

vi.mock('../api', () => ({
  api: {
    strategies: strategiesApi,
    events: eventsApi,
  },
}))

describe('StrategiesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    strategiesApi.listTemplates.mockResolvedValue({
      templates: [{
        id: 'breakout',
        label: 'Breakout',
        description: 'Momentum breakout template',
        defaults: {
          id: 'breakout',
          label: 'Breakout',
          enabled: true,
          sources: ['binance-main'],
          universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
          timeframes: { context: '1h', structure: '15m', execution: '5m' },
          riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
          behaviorRules: { preferences: ['wait for breakout'], prohibitions: ['do not trade chop'] },
          executionPolicy: {
            allowedOrderTypes: ['stop', 'stop_limit', 'take_profit'],
            requireProtection: true,
            allowMarketOrders: false,
            allowOvernight: false,
          },
        },
      }],
    })
    strategiesApi.listStrategies.mockResolvedValue({
      strategies: [{
        id: 'momentum',
        label: 'Momentum',
        enabled: true,
        sources: ['ccxt-main'],
        asset: 'crypto',
        symbols: ['BTC/USDT:USDT'],
      }],
    })
    strategiesApi.createStrategy.mockImplementation(async (draft) => draft)
    strategiesApi.updateStrategy.mockImplementation(async (_id, draft) => ({
      strategy: draft,
      changeReport: {
        changedFields: ['label'],
        summary: 'Manual edit updated label.',
        yamlDiff: '- label: Momentum\n+ label: Momentum Edited',
      },
    }))
    strategiesApi.generateStrategy.mockResolvedValue({
      draft: {
        id: 'btc-breakout',
        label: 'BTC Breakout',
        enabled: true,
        sources: ['binance-main'],
        universe: { asset: 'crypto', symbols: ['BTC/USDT:USDT'] },
        timeframes: { context: '1h', structure: '15m', execution: '5m' },
        riskBudget: { perTradeRiskPercent: 0.75, maxGrossExposurePercent: 5, maxPositions: 1 },
        behaviorRules: {
          preferences: ['Long only after a 5m close above 75471.03.'],
          prohibitions: ['Do not trade the middle of the range.'],
        },
        executionPolicy: {
          allowedOrderTypes: ['stop', 'stop_limit', 'take_profit'],
          requireProtection: true,
          allowMarketOrders: false,
          allowOvernight: false,
        },
      },
      yamlPreview: 'id: btc-breakout\nlabel: BTC Breakout\n',
    })
    strategiesApi.listJobs.mockResolvedValue({
      jobs: [{
        id: 'job-1',
        name: 'Momentum Job',
        enabled: true,
        strategyId: 'momentum',
        schedule: { kind: 'every', every: '1h' },
        state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
        createdAt: Date.now(),
      }],
    })
    strategiesApi.listReviewJobs.mockResolvedValue({ jobs: [] })
    strategiesApi.getStrategy.mockResolvedValue({
      id: 'momentum',
      label: 'Momentum',
      enabled: true,
      sources: ['ccxt-main'],
      asset: 'crypto',
      symbols: ['BTC/USDT:USDT'],
      timeframes: { context: '1h', structure: '15m', execution: '5m' },
      riskBudget: { perTradeRiskPercent: 0.5, maxGrossExposurePercent: 5, maxPositions: 1 },
      behaviorRules: { preferences: ['trade with trend'], prohibitions: ['no chasing'] },
      executionPolicy: {
        allowedOrderTypes: ['stop', 'stop_limit'],
        requireProtection: true,
        allowMarketOrders: false,
        allowOvernight: false,
      },
    })
    strategiesApi.runReview.mockResolvedValue({ updated: true, summary: 'review complete', strategyId: undefined })
    strategiesApi.addReviewJob.mockResolvedValue({ id: 'review-2' })
    const now = Date.now()
    eventsApi.recent.mockResolvedValue({
      entries: [{
        seq: 1,
        ts: now - 60_000,
        type: 'trader.review.done',
        payload: {
          strategyId: 'momentum',
          patchSummary: 'Review updated breakout thresholds.',
          yamlDiff: '- preferences: old\n+ preferences: new',
        },
      }, {
        seq: 2,
        ts: now,
        type: 'strategy.updated',
        payload: {
          strategyId: 'momentum',
          source: 'manual',
          summary: 'Manual edit updated label.',
          yamlDiff: '- label: Momentum\n+ label: Momentum Edited',
        },
      }, { seq: 3, ts: now, type: 'trader.done', payload: { reason: 'ok' } }],
      lastSeq: 3,
    })
  })

  it('renders strategies and jobs', async () => {
    render(<StrategiesPage />)

    expect(await screen.findByText('Momentum')).toBeInTheDocument()
    expect(await screen.findByText('Momentum Job')).toBeInTheDocument()
    expect(await screen.findByText('Strategy Composer')).toBeInTheDocument()
  })

  it('runs a manual review', async () => {
    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Global Review' }))

    await waitFor(() => {
      expect(strategiesApi.runReview).toHaveBeenCalledWith(undefined)
    })
    expect(await screen.findByText('Latest Review Summary')).toBeInTheDocument()
    expect(await screen.findByText(/review complete/)).toBeInTheDocument()
  })

  it('creates a strategy from a template in manual mode', async () => {
    render(<StrategiesPage />)

    fireEvent.change(await screen.findByLabelText('Strategy ID'), { target: { value: 'breakout-btc' } })
    fireEvent.change(screen.getByLabelText('Strategy label'), { target: { value: 'BTC Breakout Manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Strategy' }))

    await waitFor(() => {
      expect(strategiesApi.createStrategy).toHaveBeenCalledWith(expect.objectContaining({
        id: 'breakout-btc',
        label: 'BTC Breakout Manual',
      }))
    })
    expect(await screen.findByText(/Saved strategy BTC Breakout Manual/)).toBeInTheDocument()
  })

  it('generates an AI draft preview and saves it', async () => {
    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'AI Generate' }))
    fireEvent.change(screen.getByLabelText('AI generation request'), {
      target: { value: 'Build a BTC breakout with clear long trigger and false breakout rule.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate Draft' }))

    await waitFor(() => {
      expect(strategiesApi.generateStrategy).toHaveBeenCalledWith({
        templateId: 'breakout',
        request: 'Build a BTC breakout with clear long trigger and false breakout rule.',
      })
    })
    expect(await screen.findByText('YAML Preview')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save Generated Strategy' }))

    await waitFor(() => {
      expect(strategiesApi.createStrategy).toHaveBeenCalledWith(expect.objectContaining({
        id: 'btc-breakout',
        label: 'BTC Breakout',
      }))
    })
  })

  it('creates a review job from the form', async () => {
    render(<StrategiesPage />)

    const addButtons = await screen.findAllByRole('button', { name: '+ Add Job' })
    fireEvent.click(addButtons[1])

    fireEvent.change(screen.getByPlaceholderText('Job name'), { target: { value: 'Weekly Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(strategiesApi.addReviewJob).toHaveBeenCalledWith({
        name: 'Weekly Review',
        strategyId: undefined,
        schedule: { kind: 'every', every: '24h' },
      })
    })
  })

  it('loads and shows strategy details when expanded', async () => {
    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Show Details' }))

    await waitFor(() => {
      expect(strategiesApi.getStrategy).toHaveBeenCalledWith('momentum')
    })
    expect(await screen.findByText(/Timeframes: 1h \/ 15m \/ 5m/)).toBeInTheDocument()
    expect(await screen.findByText(/Protection required: yes/)).toBeInTheDocument()
    expect(await screen.findByText(/Latest change: Manual edit/)).toBeInTheDocument()
    expect(await screen.findByText('Recent Change Timeline')).toBeInTheDocument()
    expect((await screen.findAllByText(/Review updated breakout thresholds/)).length).toBeGreaterThan(0)
  })

  it('edits an existing strategy and saves it back to yaml', async () => {
    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Show Details' }))
    await screen.findByText(/Timeframes: 1h \/ 15m \/ 5m/)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Strategy' }))
    fireEvent.change((await screen.findAllByLabelText('Strategy label'))[1], { target: { value: 'Momentum Edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(strategiesApi.updateStrategy).toHaveBeenCalledWith('momentum', expect.objectContaining({
        id: 'momentum',
        label: 'Momentum Edited',
      }))
    })
    expect(await screen.findByText(/Latest change: Manual edit/)).toBeInTheDocument()
  })

  it('edits a trader job in place', async () => {
    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Momentum Job' }))

    const nameInput = await screen.findByDisplayValue('Momentum Job')
    fireEvent.change(nameInput, { target: { value: 'Momentum Job v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(strategiesApi.updateJob).toHaveBeenCalledWith('job-1', {
        name: 'Momentum Job v2',
        strategyId: 'momentum',
        schedule: { kind: 'every', every: '1h' },
      })
    })
  })

  it('runs and deletes trader jobs', async () => {
    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Momentum Job now' }))
    await waitFor(() => {
      expect(strategiesApi.runJob).toHaveBeenCalledWith('job-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Momentum Job' }))
    await waitFor(() => {
      expect(strategiesApi.removeJob).toHaveBeenCalledWith('job-1')
    })
  })

  it('shows an error when manual review fails', async () => {
    strategiesApi.runReview.mockRejectedValueOnce(new Error('review unavailable'))

    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Global Review' }))

    expect(await screen.findByText('review unavailable')).toBeInTheDocument()
  })

  it('edits a review job in place', async () => {
    strategiesApi.listReviewJobs.mockResolvedValue({
      jobs: [{
        id: 'review-1',
        name: 'Weekly Review',
        enabled: true,
        strategyId: undefined,
        schedule: { kind: 'every', every: '24h' },
        state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
        createdAt: Date.now(),
      }],
    })

    render(<StrategiesPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Weekly Review' }))

    const input = await screen.findByDisplayValue('Weekly Review')
    fireEvent.change(input, { target: { value: 'Weekly Review v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(strategiesApi.updateReviewJob).toHaveBeenCalledWith('review-1', {
        name: 'Weekly Review v2',
        strategyId: undefined,
        schedule: { kind: 'every', every: '24h' },
      })
    })
  })

  it('validates trader job creation before calling the API', async () => {
    render(<StrategiesPage />)

    const addButtons = await screen.findAllByRole('button', { name: '+ Add Job' })
    fireEvent.click(addButtons[0])
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Name is required')).toBeInTheDocument()
    expect(strategiesApi.addJob).not.toHaveBeenCalled()
  })
})
