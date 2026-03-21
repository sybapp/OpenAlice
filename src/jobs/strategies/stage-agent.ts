import type { SessionStore } from '../../core/session.js'
import type { TraderRunnerDeps } from './types.js'
import {
  executeStructuredAgentSkill,
  type AgentSkillRequiredScriptCall,
  type AgentSkillTrace,
} from '../../skills/service.js'

export type TraderStageRequiredScriptCall = AgentSkillRequiredScriptCall

export type TraderStageAgentTrace = AgentSkillTrace

export async function runTraderStageAgent<T>(params: {
  session: SessionStore
  skillId: string
  task: string
  schema: { parse: (value: unknown) => T }
  deps: TraderRunnerDeps
  skillContext?: Record<string, unknown>
  requiredScriptCalls?: TraderStageRequiredScriptCall[]
}) {
  return executeStructuredAgentSkill({
    runtime: params.deps.runtime,
    session: params.session,
    skillId: params.skillId,
    task: params.task,
    schema: params.schema,
    historyPreamble: 'The following is the prior structured skill-loop history for this trader session.',
    maxHistoryEntries: 30,
    skillContext: params.skillContext,
    requiredScriptCalls: params.requiredScriptCalls,
  })
}
