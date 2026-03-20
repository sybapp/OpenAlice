import { setSessionSkill } from '../../skills/session-skill.js'
import type { SessionStore } from '../../core/session.js'
import type { TraderRunnerDeps } from './types.js'

export interface TraderStageRequiredScriptCall {
  id: string
  match?: Record<string, unknown>
  rationale?: string
}

export interface TraderStageAgentTrace {
  skillId: string
  requiredScriptCalls: TraderStageRequiredScriptCall[]
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

function parseStageOutput<T>(text: string, schema: { parse: (value: unknown) => T }): T | null {
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

export async function runTraderStageAgent<T>(params: {
  session: SessionStore
  skillId: string
  task: string
  schema: { parse: (value: unknown) => T }
  deps: TraderRunnerDeps
  skillContext?: Record<string, unknown>
  requiredScriptCalls?: TraderStageRequiredScriptCall[]
}) {
  await setSessionSkill(params.session, params.skillId)
  const trace: TraderStageAgentTrace = {
    skillId: params.skillId,
    requiredScriptCalls: params.requiredScriptCalls ?? [],
    resources: [],
    scriptCalls: [],
  }
  const result = await params.deps.engine.askWithSession(params.task, params.session, {
    historyPreamble: 'The following is the prior structured skill-loop history for this trader session.',
    maxHistoryEntries: 30,
    skillContext: {
      ...(params.skillContext ?? {}),
      requiredScriptCalls: trace.requiredScriptCalls,
    },
  })
  const loopTrace = await readLatestSkillLoopTrace(params.session, params.skillId)
  if (loopTrace) {
    trace.resources = loopTrace.loadedResources ?? []
    trace.scriptCalls = loopTrace.scriptCalls ?? []
    trace.iterations = loopTrace.iterations
    trace.completionRejectedCount = loopTrace.completionRejectedCount
  }
  const output = parseStageOutput(result.text, params.schema)
  if (!output) {
    throw new Error(`Skill ${params.skillId} did not return a valid completion payload`)
  }
  return { output, rawText: result.text, trace }
}
