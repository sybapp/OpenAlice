import type { TraderWorkflowStage, TraderWorkflowStageStatus } from './types.js'
import {
  TRADER_WORKFLOW_ALLOWED_TRANSITIONS,
  type TraderWorkflowRuntimeState,
} from './workflow-stages.js'

export type { TraderWorkflowRuntimeState } from './workflow-stages.js'

export interface TraderWorkflowStageRecord {
  previousState: TraderWorkflowRuntimeState
  workflowState: TraderWorkflowStage
  stage: TraderWorkflowStage
  status: TraderWorkflowStageStatus
  allowedNextStages: readonly TraderWorkflowStage[]
}

function describeAllowedTransitions(state: TraderWorkflowRuntimeState): string {
  const allowedStages = TRADER_WORKFLOW_ALLOWED_TRANSITIONS[state]
  return allowedStages.length > 0 ? allowedStages.join(', ') : 'none'
}

export class TraderWorkflowStateMachine {
  private state: TraderWorkflowRuntimeState = 'boot'

  get current(): TraderWorkflowRuntimeState {
    return this.state
  }

  get allowedNextStages(): readonly TraderWorkflowStage[] {
    return TRADER_WORKFLOW_ALLOWED_TRANSITIONS[this.state]
  }

  record(stage: TraderWorkflowStage, status: TraderWorkflowStageStatus): TraderWorkflowStageRecord {
    if (!this.allowedNextStages.includes(stage)) {
      throw new Error(`Invalid trader workflow transition from ${this.state} to ${stage}. Allowed next stages: ${describeAllowedTransitions(this.state)}.`)
    }

    const previousState = this.state
    this.state = stage
    return {
      previousState,
      workflowState: this.state,
      stage,
      status,
      allowedNextStages: this.allowedNextStages,
    }
  }

  complete(): TraderWorkflowRuntimeState {
    this.state = 'completed'
    return this.state
  }
}
