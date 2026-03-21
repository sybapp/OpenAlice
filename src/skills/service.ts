import type { EngineAskOptions, EngineResult } from '../core/engine.js'
import type { SessionStore } from '../core/session.js'
import { setSessionSkill } from './session-skill.js'

export interface AgentSkillRequiredScriptCall {
  id: string
  match?: Record<string, unknown>
  rationale?: string
}

export interface AgentSkillTrace {
  skillId: string
  requiredScriptCalls: AgentSkillRequiredScriptCall[]
  resources: string[]
  scriptCalls: Array<{ id: string; input: unknown }>
  iterations?: number
  completionRejectedCount?: number
}

interface SkillLoopTraceMetadata {
  kind: 'skill_loop_trace'
  skillId: string
  iterations?: number
  loadedResources?: string[]
  scriptCalls?: Array<{ id: string; input: unknown }>
  completionRejectedCount?: number
  requiredScriptCalls?: AgentSkillRequiredScriptCall[]
}

export interface AgentSkillSessionRuntime {
  askWithSession(prompt: string, session: SessionStore, opts?: EngineAskOptions): Promise<EngineResult>
}

async function readLatestSkillLoopTrace(session: SessionStore, skillId: string): Promise<SkillLoopTraceMetadata | null> {
  if (typeof session.readActive !== 'function') return null
  const entries = await session.readActive().catch(() => [])
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const metadata = entries[index]?.metadata as Record<string, unknown> | undefined
    if (metadata?.kind !== 'skill_loop_trace' || metadata.skillId !== skillId) continue
    return metadata as SkillLoopTraceMetadata
  }
  return null
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence?.[1]) return fence[1].trim()

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

export function parseAgentSkillOutput<T>(text: string, schema: { parse: (value: unknown) => T }): T | null {
  const candidate = extractJsonObject(text)
  if (!candidate) return null

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const wrappedText = parsed.text
    const output = parsed.type === 'complete' && 'output' in parsed
      ? parsed.output
      : wrappedText && typeof wrappedText === 'object' && (wrappedText as Record<string, unknown>).type === 'complete' && 'output' in (wrappedText as Record<string, unknown>)
        ? (wrappedText as Record<string, unknown>).output
        : parsed
    return schema.parse(output)
  } catch {
    return null
  }
}

export async function invokeAgentSkill(params: {
  runtime: AgentSkillSessionRuntime
  session: SessionStore
  skillId: string
  task: string
  historyPreamble?: string
  maxHistoryEntries?: number
  askOptions?: Omit<EngineAskOptions, 'skillContext' | 'historyPreamble' | 'maxHistoryEntries'>
  skillContext?: Record<string, unknown>
  requiredScriptCalls?: AgentSkillRequiredScriptCall[]
}): Promise<EngineResult & { trace: AgentSkillTrace }> {
  await setSessionSkill(params.session, params.skillId)
  const trace: AgentSkillTrace = {
    skillId: params.skillId,
    requiredScriptCalls: params.requiredScriptCalls ?? [],
    resources: [],
    scriptCalls: [],
  }
  const result = await params.runtime.askWithSession(params.task, params.session, {
    ...(params.askOptions ?? {}),
    ...(params.historyPreamble ? { historyPreamble: params.historyPreamble } : {}),
    ...(typeof params.maxHistoryEntries === 'number' ? { maxHistoryEntries: params.maxHistoryEntries } : {}),
    skillContext: {
      ...(params.skillContext ?? {}),
      requiredScriptCalls: trace.requiredScriptCalls,
    },
  })

  const loopTrace = await readLatestSkillLoopTrace(params.session, params.skillId)
  if (loopTrace) {
    trace.requiredScriptCalls = loopTrace.requiredScriptCalls ?? trace.requiredScriptCalls
    trace.resources = loopTrace.loadedResources ?? []
    trace.scriptCalls = loopTrace.scriptCalls ?? []
    trace.iterations = loopTrace.iterations
    trace.completionRejectedCount = loopTrace.completionRejectedCount
  }

  return { ...result, trace }
}

export async function executeStructuredAgentSkill<T>(params: {
  runtime: AgentSkillSessionRuntime
  session: SessionStore
  skillId: string
  task: string
  schema: { parse: (value: unknown) => T }
  historyPreamble?: string
  maxHistoryEntries?: number
  askOptions?: Omit<EngineAskOptions, 'skillContext' | 'historyPreamble' | 'maxHistoryEntries'>
  skillContext?: Record<string, unknown>
  requiredScriptCalls?: AgentSkillRequiredScriptCall[]
}): Promise<{ output: T; rawText: string; trace: AgentSkillTrace }> {
  const result = await invokeAgentSkill(params)
  const output = parseAgentSkillOutput(result.text, params.schema)
  if (!output) {
    throw new Error(`Skill ${params.skillId} did not return a valid completion payload`)
  }
  return { output, rawText: result.text, trace: result.trace }
}
