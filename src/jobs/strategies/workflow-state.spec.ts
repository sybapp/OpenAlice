import { describe, expect, it } from 'vitest'
import { TraderWorkflowStateMachine } from './workflow-state.js'

describe('TraderWorkflowStateMachine', () => {
  it('tracks allowed transitions through the happy path', () => {
    const workflow = new TraderWorkflowStateMachine()

    expect(workflow.allowedNextStages).toEqual(['market-scan'])
    expect(workflow.record('market-scan', 'completed')).toMatchObject({
      previousState: 'boot',
      workflowState: 'market-scan',
      allowedNextStages: ['trade-thesis'],
    })
    expect(workflow.record('trade-thesis', 'completed')).toMatchObject({
      previousState: 'market-scan',
      workflowState: 'trade-thesis',
      allowedNextStages: ['trade-thesis', 'risk-check'],
    })
    expect(workflow.record('risk-check', 'completed')).toMatchObject({
      previousState: 'trade-thesis',
      workflowState: 'risk-check',
      allowedNextStages: ['trade-thesis', 'trade-plan'],
    })
    expect(workflow.record('trade-plan', 'completed')).toMatchObject({
      previousState: 'risk-check',
      workflowState: 'trade-plan',
      allowedNextStages: ['trade-thesis', 'trade-execute'],
    })
    expect(workflow.record('trade-execute', 'completed')).toMatchObject({
      previousState: 'trade-plan',
      workflowState: 'trade-execute',
      allowedNextStages: ['trade-thesis', 'trade-execute-script'],
    })
    expect(workflow.record('trade-execute-script', 'completed')).toMatchObject({
      previousState: 'trade-execute',
      workflowState: 'trade-execute-script',
      allowedNextStages: [],
    })
    expect(workflow.complete()).toBe('completed')
    expect(workflow.allowedNextStages).toEqual([])
  })

  it('allows candidate loopbacks after downstream skips', () => {
    const workflow = new TraderWorkflowStateMachine()

    workflow.record('market-scan', 'completed')
    workflow.record('trade-thesis', 'skipped')
    expect(workflow.record('trade-thesis', 'completed')).toMatchObject({
      previousState: 'trade-thesis',
      workflowState: 'trade-thesis',
    })
    workflow.record('risk-check', 'skipped')
    expect(workflow.record('trade-thesis', 'completed')).toMatchObject({
      previousState: 'risk-check',
      workflowState: 'trade-thesis',
    })
    workflow.record('risk-check', 'completed')
    workflow.record('trade-plan', 'skipped')
    expect(workflow.record('trade-thesis', 'completed')).toMatchObject({
      previousState: 'trade-plan',
      workflowState: 'trade-thesis',
    })
    workflow.record('risk-check', 'completed')
    workflow.record('trade-plan', 'completed')
    workflow.record('trade-execute', 'skipped')
    expect(workflow.record('trade-thesis', 'completed')).toMatchObject({
      previousState: 'trade-execute',
      workflowState: 'trade-thesis',
    })
  })

  it('rejects invalid stage jumps with a clear error', () => {
    const workflow = new TraderWorkflowStateMachine()

    expect(() => workflow.record('trade-plan', 'completed')).toThrow(
      'Invalid trader workflow transition from boot to trade-plan. Allowed next stages: market-scan.',
    )
  })
})
